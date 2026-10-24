import { create, toBinary } from '@bufbuild/protobuf';
import { expect, it, vi } from 'vitest';
import { agentV1Runtime as wire, agentV1SessionStore as storeWire } from '@mcp/agent-runtime-contracts';
import type { NativeSessionReader } from '@mcp/agent-runtime-host';
import { identity } from '../../../packages/agent-runtime-host/src/__tests__/attempt-channel-support.js';
import { encodeProviderFrontier, sha256 } from '../../../packages/agent-runtime-host/src/native/ProviderFrontierCodec.js';
import { engineRecordStorage } from '../../../packages/agent-runtime-host/src/ipc/EngineContentRecord.js';
import { inspectNativeContinuation } from '../workers/native-coder-continuation.js';

type Row = { kind: storeWire.SessionRecordKind; durability: storeWire.SessionDurabilityClass; payload: Uint8Array };
const I = identity();
function event(body: NonNullable<Parameters<typeof create<typeof storeWire.EngineEventRecordV1Schema>>[1]>['body'], attempt = I.attemptId): Row {
  const value = create(storeWire.EngineEventRecordV1Schema, { schemaVersion: 1, identity: { ...I, attemptId: attempt },
    runtimeInstanceId: 'scan-test', localSequence: 1n, body });
  return { ...engineRecordStorage(value), payload: toBinary(storeWire.EngineEventRecordV1Schema, value) };
}
function fixture(count = 1000) {
  const rows: Row[] = []; const messages: wire.ProviderMessage[] = []; let previous;
  for (let n = 0; n < count; n++) {
    const operationId = `provider/${n}`;
    rows.push(event({ case: 'providerStarted', value: { operationId } }));
    messages.push(create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER,
      content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: `turn ${n}` } } } }] }));
    const encoded = encodeProviderFrontier(create(wire.ProviderStartSchema, { identity: I, operationId, messages,
      binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' } }), n % 32 ? previous : undefined);
    previous = encoded.frontier;
    rows.push({ kind: storeWire.SessionRecordKind.CHECKPOINT, durability: storeWire.SessionDurabilityClass.AUTHORITATIVE, payload: encoded.payload });
  }
  rows.push(event({ case: 'terminal', value: { classification: storeWire.EngineTerminalClassificationV1.INTERRUPTED } }));
  return { rows, messages };
}
function reader(rows: Row[]) {
  const receipts = rows.map((row, n) => create(storeWire.CommitSessionRecordReceiptSchema, {
    sessionId: I.sessionId, operationId: `record/${n}`, kind: row.kind, durability: row.durability,
    globalSequence: BigInt(n + 1), payloadBytes: BigInt(row.payload.length), payloadSha256: sha256(row.payload), commitSha256: new Uint8Array(32),
  }));
  const read = vi.fn(async (receipt: storeWire.CommitSessionRecordReceipt) => rows[Number(receipt.globalSequence) - 1]!.payload);
  const assertCurrent = vi.fn(async () => undefined);
  return { read, assertCurrent, value: { assertCurrent,
    state: { sessionId: I.sessionId, authority: { writerId: I.attemptId }, committedRecords: BigInt(rows.length), lastCommitSha256: new Uint8Array(32) },
    store: { read, async list(after: bigint, maximum: number) {
      const records = receipts.slice(Number(after), Number(after) + maximum);
      const next = records.at(-1)?.globalSequence ?? after;
      return { records, nextGlobalSequence: next, complete: next === BigInt(rows.length) };
    } },
  } as unknown as NativeSessionReader };
}
it('starts another command without loading any provider checkpoint payload', async () => {
  const f = reader(fixture().rows);
  await expect(inspectNativeContinuation(f.value, false)).resolves.toBeUndefined();
  expect(f.read.mock.calls.every(([receipt]) => receipt.kind === storeWire.SessionRecordKind.LIFECYCLE_EVENT)).toBe(true);
  expect(f.read).toHaveBeenCalledTimes(1001); expect(f.assertCurrent).toHaveBeenCalledOnce();
});
it('reconstructs only the latest full checkpoint and its deltas when resuming', async () => {
  const { rows, messages } = fixture(); const f = reader(rows);
  const proof = await inspectNativeContinuation(f.value, true);
  expect(proof?.sourceAgentRunId).toBe(I.agentRunId);
  expect(proof?.messagesSha256).toBe(Buffer.from(sha256(toBinary(wire.ProviderTurnContextSchema,
    create(wire.ProviderTurnContextSchema, { messages })))).toString('hex'));
  const checkpointReads = f.read.mock.calls.map(([receipt]) => receipt).filter(receipt => receipt.kind === storeWire.SessionRecordKind.CHECKPOINT);
  expect(checkpointReads).toHaveLength(16);
  expect(checkpointReads.every(receipt => receipt.globalSequence >= 1986n)).toBe(true);
});
it.each([false, true])('never skips an uncertain effect from an older attempt, resume=%s', async resume => {
  const shared = { operationId: 'mutation', toolUseId: 'tool', grantId: 'grant' };
  const rows = [event({ case: 'capabilityDispatchStarted', value: { ...shared, effectiveInputSha256: new Uint8Array(32), startedAtUnixMs: 10n } }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    event({ case: 'capabilityTerminal', value: { ...shared, completedAtUnixMs: 11n,
      classification: storeWire.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN, reasonCode: 'lost' } }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), ...fixture(40).rows];
  await expect(inspectNativeContinuation(reader(rows).value, resume)).rejects.toThrow('unresolved effects');
});
it('does not allow a final checkpoint to bypass an earlier completed run', async () => {
  const { rows } = fixture(40);
  rows[0] = event({ case: 'terminal', value: { classification: storeWire.EngineTerminalClassificationV1.COMPLETED } });
  await expect(inspectNativeContinuation(reader(rows).value, true)).rejects.toThrow('no settled interrupted');
});
it('blocks a settled mutation whose result is absent from the last frontier', async () => {
  const { rows } = fixture(40); rows.pop();
  const shared = { operationId: 'late', toolUseId: 'late-tool', grantId: 'late-grant' };
  rows.push(event({ case: 'capabilityDispatchStarted', value: { ...shared, effectiveInputSha256: new Uint8Array(32), startedAtUnixMs: 10n } }),
    event({ case: 'capabilityTerminal', value: { ...shared, completedAtUnixMs: 11n, classification: storeWire.EngineCapabilityTerminalClassificationV1.SUCCEEDED } }),
    event({ case: 'terminal', value: { classification: storeWire.EngineTerminalClassificationV1.INTERRUPTED } }));
  await expect(inspectNativeContinuation(reader(rows).value, true)).rejects.toThrow('no settled interrupted');
});
it.each([false, true])('requires the confirmed workspace transition even for a new command, resume=%s', async resume => {
  const { rows } = fixture(40);
  rows[rows.length - 1] = event({ case: 'terminal', value: {
    classification: storeWire.EngineTerminalClassificationV1.INTERRUPTED, reasonCode: 'workspace_transition',
  } });
  await expect(inspectNativeContinuation(reader(rows).value, resume)).rejects.toThrow('confirmed materialization');
  const check = vi.fn(async (): Promise<void> => { throw new Error('transition is still uncertain'); });
  await expect(inspectNativeContinuation(reader(rows).value, resume, undefined,
    { assertWorkspaceTransition: check })).rejects.toThrow('transition is still uncertain');
  expect(check).toHaveBeenCalledWith(I.attemptId);
  check.mockImplementation(async () => undefined);
  await inspectNativeContinuation(reader(rows).value, resume, undefined, { assertWorkspaceTransition: check });
});
