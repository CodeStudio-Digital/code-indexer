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
import { engineRecordStorage } from '../ipc/EngineContentRecord.js';

const SESSION = identity().sessionId;
const RUNTIME = 'runtime/recovery';

describe('native engine event recovery scanner', () => {
  it('delivers authenticated transcript content to continuation observers', async () => {
    const bytes = Buffer.from('confirmed partial response');
    const record = create(agentV1SessionStore.EngineEventRecordV1Schema, {
      schemaVersion: 1, identity: identity(), runtimeInstanceId: RUNTIME, localSequence: 1n,
      body: { case: 'content', value: { kind: agentV1SessionStore.EngineContentKindV1.TRANSCRIPT,
        operationId: 'provider/1', contentId: 'content/1', contentSchemaId: 'text/utf8', contentSchemaVersion: 1,
        encodedChunk: bytes, totalBytes: BigInt(bytes.length), contentSha256: digest(bytes) } },
    });
    const seen: string[] = [];
    const source = fixture([record]);
    await expect(inspectUnresolvedCapabilityDispatches(source.store, SESSION, 8,
      (_receipt, _bytes, event) => { seen.push(event?.body.case ?? 'checkpoint'); })).resolves.toEqual([]);
    expect(seen).toEqual(['content']);
    const list = source.store.list.bind(source.store);
    source.store.list = async (...args) => {
      const page = await list(...args);
      page.records[0]!.durability = agentV1SessionStore.SessionDurabilityClass.AUTHORITATIVE;
      return page;
    };
    await expect(inspectUnresolvedCapabilityDispatches(source.store, SESSION, 8, () => {}))
      .rejects.toThrow('storage classification diverged');
  });

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

  it('keeps a durable unknown effect unresolved and refuses a replacement terminal', async () => {
    const unknown = terminal(2n);
    if (unknown.body.case !== 'capabilityTerminal') throw new Error('fixture');
    unknown.body.value.classification = agentV1SessionStore.EngineCapabilityTerminalClassificationV1.OUTCOME_UNKNOWN;
    unknown.body.value.reasonCode = 'ack_lost_after_effect';
    const unresolved = await inspectUnresolvedCapabilityDispatches(fixture([started(1n), unknown]).store, SESSION, 8);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.outcomeUnknownReason).toBe('ack_lost_after_effect');
    await expect(inspectUnresolvedCapabilityDispatches(fixture([started(1n), unknown, terminal(3n)]).store, SESSION, 8))
      .rejects.toThrow('explicit reconciliation');
  });

  it('does not let an unspecified terminal settle a started effect', async () => {
    const invalid = terminal(2n);
    if (invalid.body.case !== 'capabilityTerminal') throw new Error('fixture');
    invalid.body.value.classification = agentV1SessionStore.EngineCapabilityTerminalClassificationV1.UNSPECIFIED;
    await expect(inspectUnresolvedCapabilityDispatches(fixture([started(1n), invalid]).store, SESSION, 8))
      .rejects.toThrow('classification or time');
  });

  it('rejects a store page that exceeds the remaining scan budget', async () => {
    const source = fixture([started(1n), terminal(2n)]).store;
    const list = source.list.bind(source);
    source.list = after => list(after, 2);
    await expect(inspectUnresolvedCapabilityDispatches(source, SESSION, 1))
      .rejects.toThrow('page is invalid');
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
      ...engineRecordStorage(event),
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
