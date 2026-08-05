import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import {
  inspectUnresolvedCapabilityDispatches,
  type EngineEventRecoveryStorePort,
} from '../native/NativeEngineEventRecovery.js';
import { identity } from './attempt-channel-support.js';

const SESSION = identity().sessionId;
const RUNTIME = 'runtime/recovery';

describe('native engine event recovery scanner', () => {
  it('returns a started capability only when no exact terminal proof exists', async () => {
    const open = fixture([started(1n)]);

    const unresolved = await inspectUnresolvedCapabilityDispatches(
      open.store,
      SESSION,
      8,
    );

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      runtimeInstanceId: RUNTIME,
      operationId: 'capability/tool/1',
      toolUseId: 'tool/1',
      grantId: 'grant/1',
      startedAtUnixMs: 100n,
      journalSequence: 1n,
    });
  });

  it('removes a started capability only for its exact terminal authority', async () => {
    const complete = fixture([started(1n), terminal(2n)]);

    await expect(inspectUnresolvedCapabilityDispatches(
      complete.store,
      SESSION,
      8,
    )).resolves.toEqual([]);

    const divergent = terminal(2n);
    if (divergent.body.case !== 'capabilityTerminal') {
      throw new Error('terminal fixture diverged');
    }
    divergent.body.value.toolUseId = 'tool/foreign';
    await expect(inspectUnresolvedCapabilityDispatches(
      fixture([started(1n), divergent]).store,
      SESSION,
      8,
    )).rejects.toThrow(/exact started authority/);
  });

  it('fails closed when its total scan budget cannot reach the journal tail', async () => {
    const records = fixture([started(1n), terminal(2n)]);

    await expect(inspectUnresolvedCapabilityDispatches(
      records.store,
      SESSION,
      1,
    )).rejects.toThrow(/scan limit exceeded/);
  });
});

function fixture(
  events: agentV1SessionStore.EngineEventRecordV1[],
): { store: EngineEventRecoveryStorePort } {
  const records = events.map((event, index) => {
    const payload = toBinary(agentV1SessionStore.EngineEventRecordV1Schema, event);
    const sequence = BigInt(index + 1);
    const receipt = create(agentV1SessionStore.CommitSessionRecordReceiptSchema, {
      sessionId: SESSION,
      operationId: `event/${sequence}`,
      authority: create(agentV1SessionStore.SessionStoreAuthoritySchema, {
        storageGeneration: agentV1SessionStore.StorageGeneration.RUST_FS_V1,
        leaseEpoch: 1n,
        writerId: '20000000-0000-0000-0000-000000000001',
      }),
      globalSequence: sequence,
      kind: agentV1SessionStore.SessionRecordKind.LIFECYCLE_EVENT,
      durability: agentV1SessionStore.SessionDurabilityClass.AUTHORITATIVE,
      previousCommitSha256: new Uint8Array(32).fill(index),
      payloadSha256: digest(payload),
      commitSha256: new Uint8Array(32).fill(index + 1),
      payloadBytes: BigInt(payload.byteLength),
    });
    return { receipt, payload };
  });
  return {
    store: {
      async list(after, maximum) {
        const start = Number(after);
        const selected = records.slice(start, start + maximum);
        const next = selected.at(-1)?.receipt.globalSequence ?? after;
        return {
          records: selected.map(({ receipt }) => receipt),
          nextGlobalSequence: next,
          complete: next === BigInt(records.length),
        };
      },
      async read(receipt) {
        const item = records.find(({ receipt: candidate }) =>
          candidate.globalSequence === receipt.globalSequence);
        if (!item) throw new Error('missing fixture payload');
        return item.payload;
      },
    },
  };
}

function started(localSequence: bigint) {
  return create(agentV1SessionStore.EngineEventRecordV1Schema, {
    schemaVersion: 1,
    identity: identity(),
    runtimeInstanceId: RUNTIME,
    localSequence,
    body: {
      case: 'capabilityDispatchStarted',
      value: create(
        agentV1SessionStore.EngineCapabilityDispatchStartedRecordV1Schema,
        {
          operationId: 'capability/tool/1',
          toolUseId: 'tool/1',
          grantId: 'grant/1',
          effectiveInputSha256: new Uint8Array(32).fill(7),
          startedAtUnixMs: 100n,
        },
      ),
    },
  });
}

function terminal(localSequence: bigint) {
  return create(agentV1SessionStore.EngineEventRecordV1Schema, {
    schemaVersion: 1,
    identity: identity(),
    runtimeInstanceId: RUNTIME,
    localSequence,
    body: {
      case: 'capabilityTerminal',
      value: create(agentV1SessionStore.EngineCapabilityTerminalRecordV1Schema, {
        operationId: 'capability/tool/1',
        toolUseId: 'tool/1',
        grantId: 'grant/1',
        classification:
          agentV1SessionStore.EngineCapabilityTerminalClassificationV1.SUCCEEDED,
        reasonCode: 'succeeded',
        completedAtUnixMs: 101n,
      }),
    },
  });
}

function digest(value: Uint8Array): Uint8Array {
  return createHash('sha256').update(value).digest();
}
