import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire, agentV1SessionStore as storeWire } from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import { encodeProviderFrontier, decodeProviderFrontier, sha256 } from '../native/ProviderFrontierCodec.js';
import { inspectProviderFrontier } from '../native/NativeProviderFrontierRecovery.js';
import type { EngineEventRecoveryStorePort } from '../native/NativeEngineEventRecovery.js';
import { identity } from './attempt-channel-support.js';

const sessionId = identity().sessionId;
const runId = identity().agentRunId;
const S = storeWire.SessionRecordKind;

describe('durable provider frontier', () => {
  it('recovers only the latest complete checkpoint chain, across metadata pages', async () => {
    const records: { kind: storeWire.SessionRecordKind; payload: Uint8Array }[] = [];
    let previous;
    const messages: wire.ProviderMessage[] = [];
    for (let index = 0; index < 1000; index++) {
      messages.push(message(`turn ${index}`));
      const encoded = encodeProviderFrontier(start(`turn/${index}`, messages), index % 32 ? previous : undefined);
      previous = encoded.frontier;
      records.push({ kind: S.CHECKPOINT, payload: encoded.payload });
    }
    const store = journal(records); const read = store.read; const reads: bigint[] = [];
    store.read = async receipt => { reads.push(receipt.globalSequence); return read(receipt); };
    const recovered = await inspectProviderFrontier(store, sessionId, runId, 1000);
    expect(recovered.status).toBe('resumable');
    if (recovered.status !== 'resumable') throw new Error('missing frontier');
    expect(recovered.frontier.context!.messages).toEqual(messages);
    // Last full checkpoint is record 993. Earlier payloads were already
    // validated when the native immutable snapshot was opened.
    expect(reads).toHaveLength(16); expect(reads.every(sequence => sequence >= 993n)).toBe(true);
  });

  it('never uses another run checkpoint to skip an unconfirmed effect', async () => {
    const first = encodeProviderFrontier(start('first', [message('task')]));
    const latest = encodeProviderFrontier(start('latest', [message('latest')]));
    const other = start('other', [message('another run')]);
    other.identity = { ...identity(), agentRunId: 'another-run' };
    const otherCheckpoint = encodeProviderFrontier(other);
    const records = [{ kind: S.CHECKPOINT, payload: first.payload }, effect('started'), effect('unknown'),
      { kind: S.CHECKPOINT, payload: latest.payload }, { kind: S.CHECKPOINT, payload: otherCheckpoint.payload }];
    await expect(inspectProviderFrontier(journal(records), sessionId, runId, 32))
      .resolves.toEqual({ status: 'blocked', reason: 'unresolved_effect' });
  });

  it('does not skip an invalid delta after the latest complete checkpoint', async () => {
    const first = encodeProviderFrontier(start('first', [message('task')]));
    const next = encodeProviderFrontier(start('next', [message('task'), message('next')]), first.frontier);
    const corrupt = fromBinary(wire.ProviderFrontierRecordV1Schema, next.payload);
    corrupt.baseFrontierSha256[0] ^= 1;
    await expect(inspectProviderFrontier(journal([{ kind: S.CHECKPOINT, payload: first.payload },
      { kind: S.CHECKPOINT, payload: toBinary(wire.ProviderFrontierRecordV1Schema, corrupt) }]), sessionId, runId, 32))
      .rejects.toThrow('base diverged');
  });

  it('rejects oversized metadata pages even when they contain a complete checkpoint', async () => {
    const first = encodeProviderFrontier(start('first', [message('task')]));
    const source = journal([{ kind: S.CHECKPOINT, payload: first.payload }, effect('started')]);
    const list = source.list.bind(source);
    source.list = after => list(after, 2);
    await expect(inspectProviderFrontier(source, sessionId, runId, 1)).rejects.toThrow('page is invalid');
  });

  it('compares nested unknown bytes and keeps their committed copy immutable', () => {
    const original = message('task');
    original.content[0]!.$unknown = [{ no: 100, wireType: 0, data: Uint8Array.of(1) }];
    const first = encodeProviderFrontier(start('one', [original]));
    original.content[0]!.$unknown![0]!.data[0] = 2;
    expect(first.frontier.value.context!.messages[0]!.content[0]!.$unknown![0]!.data[0]).toBe(1);
    const changed = encodeProviderFrontier(start('two', [original, message('next')]), first.frontier);
    expect(fromBinary(wire.ProviderFrontierRecordV1Schema, changed.payload).baseOperationId).toBe('');
    expect(decodeProviderFrontier(changed.payload)).toEqual(changed.frontier);
  });

  it('isolates a committed delta from later caller mutations', () => {
    const original = start('one', [message('original')]);
    const first = encodeProviderFrontier(original);
    const next = start('two', [message('original'), message('next')]);
    const second = encodeProviderFrontier(next, first.frontier);
    original.messages[0]!.content = message('rewritten base').content;
    next.messages[0]!.content = message('rewritten prefix').content;
    next.messages[1]!.content = message('rewritten delta').content;
    expect(decodeProviderFrontier(second.payload, first.frontier)).toEqual(second.frontier);
    expect(second.frontier.value.context!.messages).toEqual([message('original'), message('next')]);
  });

  it('scopes duplicate tool IDs to one assistant message while requiring each result exactly once', () => {
    const messages = [message('task'), toolUse(), toolResult(), toolUse(), toolResult()];
    const encoded = encodeProviderFrontier(start('reused', messages));
    expect(decodeProviderFrontier(encoded.payload).value.context?.messages).toEqual(messages);
    const duplicate = toolUse(); duplicate.content.push(...toolUse().content);
    expect(() => encodeProviderFrontier(start('duplicate', [message('task'), duplicate, toolResult()])))
      .toThrow('tool call is invalid');
    expect(() => encodeProviderFrontier(start('unresolved', [message('task'), toolUse(), toolUse(), toolResult()])))
      .toThrow('message order');
  });
  it('persists only the new messages and authenticates the complete reconstruction', () => {
    const first = encodeProviderFrontier(start('one', [message('a'.repeat(100_000))]));
    const second = encodeProviderFrontier(start('two', [message('a'.repeat(100_000)), message('next')]), first.frontier);
    expect(second.payload.length).toBeLessThan(1_024);
    expect(decodeProviderFrontier(second.payload, decodeProviderFrontier(first.payload)))
      .toEqual(second.frontier);
    expect(() => decodeProviderFrontier(second.payload)).toThrow('base diverged');
    const corrupt = fromBinary(wire.ProviderFrontierRecordV1Schema, second.payload);
    corrupt.frontier!.context!.messages[0] = message('tampered');
    expect(() => decodeProviderFrontier(toBinary(wire.ProviderFrontierRecordV1Schema, corrupt), first.frontier))
      .toThrow('digest diverged');
  });

  it('starts a full checkpoint when compaction changes the prefix or attempt', () => {
    const first = encodeProviderFrontier(start('one', [message('old')]));
    const next = encodeProviderFrontier(start('two', [message('summary')]), first.frontier);
    expect(fromBinary(wire.ProviderFrontierRecordV1Schema, next.payload).baseOperationId).toBe('');
    expect(decodeProviderFrontier(next.payload).value.context!.messages).toEqual([message('summary')]);
    const replacement = start('three', [message('old'), message('next')]);
    replacement.identity!.attemptId = '20000000-0000-4000-8000-000000000077';
    expect(fromBinary(wire.ProviderFrontierRecordV1Schema,
      encodeProviderFrontier(replacement, first.frontier).payload).baseOperationId).toBe('');
  });

  it('blocks both uncertain effects and known effects omitted from the last frontier', async () => {
    const checkpoint = encodeProviderFrontier(start('one', [message('task')]));
    const records = [{ kind: S.CHECKPOINT, payload: checkpoint.payload }, effect('started')];
    await expect(inspectProviderFrontier(journal(records), sessionId, runId, 32))
      .resolves.toEqual({ status: 'blocked', reason: 'unresolved_effect' });
    records.push(effect('terminal'));
    await expect(inspectProviderFrontier(journal(records), sessionId, runId, 32))
      .resolves.toEqual({ status: 'blocked', reason: 'effect_after_frontier' });
  });

  it('restores an exact committed tool/result frontier after a successful effect', async () => {
    const first = encodeProviderFrontier(start('one', [message('task')]));
    const next = encodeProviderFrontier(start('two', [message('task'), toolUse(), toolResult()]), first.frontier);
    const records = [{ kind: S.CHECKPOINT, payload: first.payload }, effect('started'), effect('terminal'),
      { kind: S.CHECKPOINT, payload: next.payload }];
    const restored = await inspectProviderFrontier(journal(records), sessionId, runId, 32);
    expect(restored.status).toBe('resumable');
    if (restored.status !== 'resumable') throw new Error('missing frontier');
    expect(fromBinary(wire.ProviderResumeContextV1Schema, restored.encodedFrontier)).toEqual(next.frontier.value);
    expect(restored.receipt.globalSequence).toBe(4n);
    // Exact scan limit reaches the tail; an incomplete scan must not authorize resume.
    await expect(inspectProviderFrontier(journal(records), sessionId, runId, 3)).rejects.toThrow('scan limit');
  });

  it('does not allow a later checkpoint to clear an unknown outcome', async () => {
    const checkpoint = encodeProviderFrontier(start('one', [message('task')]));
    const records = [effect('started'), effect('unknown'), { kind: S.CHECKPOINT, payload: checkpoint.payload }];
    await expect(inspectProviderFrontier(journal(records), sessionId, runId, 32))
      .resolves.toEqual({ status: 'blocked', reason: 'unresolved_effect' });
  });

  it('rejects incomplete tool pairs and receipt corruption', async () => {
    expect(() => encodeProviderFrontier(start('one', [message('task'), toolUse()])))
      .toThrow('unanswered tools');
    const checkpoint = encodeProviderFrontier(start('one', [message('task')]));
    const store = journal([{ kind: S.CHECKPOINT, payload: checkpoint.payload }]);
    store.read = async () => new Uint8Array(1);
    await expect(inspectProviderFrontier(store, sessionId, runId, 32)).rejects.toThrow('receipt');
  });
});

function start(operationId: string, messages: wire.ProviderMessage[]): wire.ProviderStart {
  return create(wire.ProviderStartSchema, { identity: identity(), operationId, messages,
    binding: { effectiveProvider: 'test', effectiveModel: 'test' } });
}
function message(text: string): wire.ProviderMessage {
  return create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER,
    content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: text } } } }] });
}
function toolUse(): wire.ProviderMessage {
  const args = new TextEncoder().encode('{}');
  return create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT,
    content: [{ body: { case: 'toolUse', value: { toolUseId: 'tool/1', capabilityName: 'edit',
      encodedJsonArguments: args, argumentsSha256: sha256(args) } } }] });
}
function toolResult(): wire.ProviderMessage {
  return create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.TOOL,
    content: [{ body: { case: 'toolResult', value: { toolUseId: 'tool/1', content: {
      case: 'inlineUtf8', value: 'edited' } } } }] });
}
function effect(kind: 'started' | 'terminal' | 'unknown') {
  const shared = { operationId: 'effect/1', toolUseId: 'tool/1', grantId: 'grant/1' };
  const record = create(storeWire.EngineEventRecordV1Schema, { schemaVersion: 1, identity: identity(),
    runtimeInstanceId: 'runtime/1', localSequence: kind === 'started' ? 1n : 2n,
    body: kind === 'started' ? { case: 'capabilityDispatchStarted', value: { ...shared,
      effectiveInputSha256: new Uint8Array(32), startedAtUnixMs: 10n } }
      : { case: 'capabilityTerminal', value: { ...shared, completedAtUnixMs: 11n, reasonCode: 'result',
        classification: kind === 'unknown' ? storeWire.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN
          : storeWire.EngineCapabilityTerminalClassificationV1.SUCCEEDED } },
  });
  return { kind: S.LIFECYCLE_EVENT, payload: toBinary(storeWire.EngineEventRecordV1Schema, record) };
}
function journal(records: { kind: storeWire.SessionRecordKind; payload: Uint8Array }[]): EngineEventRecoveryStorePort {
  const receipts = records.map(({ kind, payload }, index) => create(storeWire.CommitSessionRecordReceiptSchema, {
    sessionId, operationId: `record/${index}`, kind, globalSequence: BigInt(index + 1),
    payloadBytes: BigInt(payload.length), payloadSha256: sha256(payload), commitSha256: new Uint8Array(32),
    durability: storeWire.SessionDurabilityClass.AUTHORITATIVE,
  }));
  return {
    async list(after, maximum) {
      const page = receipts.slice(Number(after), Number(after) + maximum);
      const next = page.at(-1)?.globalSequence ?? after;
      return { records: page, nextGlobalSequence: next, complete: next === BigInt(records.length) };
    },
    async read(receipt) { return records[Number(receipt.globalSequence) - 1]!.payload; },
  };
}
