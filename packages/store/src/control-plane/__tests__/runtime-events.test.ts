import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asRuntimeEventId,
  asSessionCommandId,
  asSessionId,
  type RuntimeEventEnvelopeV1,
} from '@mcp/agent-runtime-contracts';
import { controlPlaneFoundation251 } from '../../migrations/251_control_plane_foundation.js';
import { ControlPlaneStore } from '../control-plane-store.js';
import { hashControlPlanePayload } from '../codec.js';
import {
  ProjectionCursorConflictError,
  ProjectionCursorStore,
} from '../projection-cursor-store.js';
import {
  RuntimeEventConflictError,
  RuntimeJournalStore,
} from '../runtime-journal-store.js';
import { RuntimeProjectionReplay } from '../runtime-projection-replay.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const ACTOR = {
  actorId: 'test-user',
  actorType: 'user' as const,
  source: 'http' as const,
};
const REDACTION = {
  policyVersion: 'test-v1',
  fields: [] as string[],
  secretRefs: [] as string[],
};
const SESSION_A = asSessionId('session:a');
const SESSION_B = asSessionId('session:b');

let db: DB;
let journal: RuntimeJournalStore;
let cursors: ProjectionCursorStore;

function seedSession(sessionId: string, legacySessionId?: number): void {
  const at = '2026-01-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO control_plane_sessions (
      session_id, legacy_session_id, version, created_at, updated_at
    ) VALUES (?, ?, 0, ?, ?)
  `).run(sessionId, legacySessionId ?? null, at, at);
}

function appendEvent(
  partitionKey: string,
  eventId: string,
  payload: Record<string, unknown>,
): RuntimeEventEnvelopeV1<Record<string, unknown>> {
  return journal.append({
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    eventId: asRuntimeEventId(eventId),
    eventClass: 'C',
    partitionKey,
    sessionId: asSessionId(partitionKey),
    correlationId: asCorrelationId(`correlation:${partitionKey}`),
    type: 'test.event',
    occurredAt: '2026-01-01T00:00:00.000Z',
    actor: ACTOR,
    payload,
    idempotencyKey: `idempotency:${eventId}`,
    redaction: REDACTION,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  controlPlaneFoundation251.up(db);
  seedSession(SESSION_A);
  seedSession(SESSION_B);
  journal = new RuntimeJournalStore(db);
  cursors = new ProjectionCursorStore(db);
});

afterEach(() => db.close());

describe('runtime journal idempotency', () => {
  it('returns the persisted envelope for an identical retry and rejects payload drift', () => {
    const first = appendEvent(SESSION_A, 'event:retry', { value: 1 });
    const duplicate = appendEvent(SESSION_A, 'event:retry', { value: 1 });

    expect(duplicate.globalSeq).toBe(first.globalSeq);
    expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get()).toEqual({ count: 1 });
    expect(() => appendEvent(SESSION_A, 'event:retry', { value: 2 }))
      .toThrow(RuntimeEventConflictError);
  });
});

describe('RuntimeProjectionReplay', () => {
  it('replays one partition in global sequence order and resumes from the durable cursor', async () => {
    const firstA = appendEvent(SESSION_A, 'event:a:1', { value: 'a1' });
    appendEvent(SESSION_B, 'event:b:1', { value: 'b1' });
    const secondA = appendEvent(SESSION_A, 'event:a:2', { value: 'a2' });
    const delivered: number[] = [];

    const firstProcess = new RuntimeProjectionReplay(journal, cursors);
    const firstBatch = await firstProcess.runBatch({
      projectionId: 'projection:test',
      projectionVersion: 'v1',
      partitionKey: SESSION_A,
      apply: (event) => { delivered.push(event.globalSeq); },
    }, { limit: 1 });

    expect(firstBatch).toEqual({
      delivered: 1,
      lastGlobalSeq: firstA.globalSeq,
      caughtUp: false,
    });

    const restartedProcess = new RuntimeProjectionReplay(
      new RuntimeJournalStore(db),
      new ProjectionCursorStore(db),
    );
    const secondBatch = await restartedProcess.runBatch({
      projectionId: 'projection:test',
      projectionVersion: 'v1',
      partitionKey: SESSION_A,
      apply: (event) => { delivered.push(event.globalSeq); },
    }, { limit: 10 });

    expect(delivered).toEqual([firstA.globalSeq, secondA.globalSeq]);
    expect(secondBatch).toEqual({
      delivered: 1,
      lastGlobalSeq: secondA.globalSeq,
      caughtUp: true,
    });
    expect(cursors.get('projection:test', SESSION_B)).toBeNull();
  });

  it('redelivers after projection failure because cursor advancement happens last', async () => {
    const event = appendEvent(SESSION_A, 'event:redelivery', { value: 1 });
    const delivered: number[] = [];
    let fail = true;
    const projection = {
      projectionId: 'projection:redelivery',
      projectionVersion: 'v1',
      partitionKey: SESSION_A,
      apply: (entry: RuntimeEventEnvelopeV1) => {
        delivered.push(entry.globalSeq);
        if (fail) throw new Error('projection write failed');
      },
    };

    await expect(new RuntimeProjectionReplay(journal, cursors).runBatch(projection))
      .rejects.toThrow('projection write failed');
    expect(cursors.get(projection.projectionId, SESSION_A)?.lastGlobalSeq).toBe(0);

    fail = false;
    await new RuntimeProjectionReplay(journal, cursors).runBatch(projection);
    expect(delivered).toEqual([event.globalSeq, event.globalSeq]);
    expect(cursors.get(projection.projectionId, SESSION_A)?.lastGlobalSeq).toBe(event.globalSeq);
  });

  it('uses cursor CAS so competing consumers cannot overwrite the winner', async () => {
    const event = appendEvent(SESSION_A, 'event:cas', { value: 1 });
    const effects: number[] = [];
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const projection = {
      projectionId: 'projection:cas',
      projectionVersion: 'v1',
      partitionKey: SESSION_A,
      apply: async (entry: RuntimeEventEnvelopeV1) => {
        effects.push(entry.globalSeq);
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      },
    };

    const results = await Promise.allSettled([
      new RuntimeProjectionReplay(journal, cursors).runBatch(projection),
      new RuntimeProjectionReplay(journal, cursors).runBatch(projection),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(ProjectionCursorConflictError) });
    expect(effects).toEqual([event.globalSeq, event.globalSeq]);
    expect(cursors.get(projection.projectionId, SESSION_A)?.lastGlobalSeq).toBe(event.globalSeq);
  });
});

describe('control-plane restart recovery', () => {
  it('deduplicates command retries and fences an orphaned run after restart', () => {
    db.prepare('INSERT INTO coder_sessions(id) VALUES (?)').run(7);
    const payload = { content: 'run this' };
    const command = {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      commandId: asSessionCommandId('command:start:1'),
      idempotencyKey: 'client-message:1',
      kind: 'start' as const,
      sessionId: asSessionId('session:legacy:7'),
      actor: ACTOR,
      requestedAt: '2026-01-01T00:00:00.000Z',
      correlationId: asCorrelationId('correlation:start:1'),
      payload,
    };
    const store = new ControlPlaneStore(db, { journalEnabled: true });
    const first = store.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(payload),
      legacySessionId: 7,
      run: {
        agentRunId: asAgentRunId('agent-run:1'),
        attemptId: asAgentRunAttemptId('attempt:1'),
        role: 'build',
        agentDefinitionId: 'build',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'navigate',
        executorOwnerId: 'coder-worker:7',
        executorExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    });
    const duplicate = store.acceptCommand({
      command: {
        ...command,
        commandId: asSessionCommandId('command:start:retry'),
        correlationId: asCorrelationId('correlation:start:retry'),
      },
      payloadHash: hashControlPlanePayload(payload),
      legacySessionId: 7,
      run: {
        agentRunId: asAgentRunId('agent-run:retry'),
        attemptId: asAgentRunAttemptId('attempt:retry'),
        role: 'build',
        agentDefinitionId: 'build',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'navigate',
        executorOwnerId: 'coder-worker:7',
        executorExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    });

    expect(first.kind).toBe('accepted');
    expect(duplicate).toMatchObject({
      kind: 'existing',
      command: { commandId: command.commandId, agentRunId: asAgentRunId('agent-run:1') },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_commands').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT version FROM control_plane_sessions WHERE session_id = ?').get(command.sessionId))
      .toEqual({ version: 1 });

    const restarted = new ControlPlaneStore(db, { journalEnabled: true });
    expect(restarted.recoverInterruptedRuns('process-restart', '2026-01-02T00:00:00.000Z')).toBe(1);
    expect(restarted.runs.get('agent-run:1')).toMatchObject({
      status: 'interrupted',
      terminalReason: 'process-restart',
    });
    expect(restarted.runs.getAttempt('attempt:1')).toMatchObject({
      status: 'terminal',
      executorLease: { status: 'fenced' },
      terminalReason: 'process-restart',
    });
    expect(restarted.commands.get(command.commandId)).toMatchObject({
      status: 'failed',
      reasonCode: 'process-restart',
    });
    expect(new ControlPlaneStore(db, { journalEnabled: true }).recoverInterruptedRuns()).toBe(0);
  });

  it('checks legacy command-kind aliases in the same acceptance transaction', () => {
    db.prepare('INSERT INTO coder_sessions(id) VALUES (?)').run(8);
    const store = new ControlPlaneStore(db, { journalEnabled: true });
    const sessionId = asSessionId('session:legacy:8');
    const payload = { content: 'first message' };
    const legacy = {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      commandId: asSessionCommandId('command:legacy-start'),
      idempotencyKey: 'first-message-key',
      kind: 'start' as const,
      sessionId,
      actor: ACTOR,
      requestedAt: '2026-01-01T00:00:00.000Z',
      correlationId: asCorrelationId('correlation:legacy-start'),
      payload,
    };
    expect(store.acceptCommand({
      command: legacy,
      payloadHash: hashControlPlanePayload(payload),
      legacySessionId: 8,
    }).kind).toBe('accepted');

    const canonical = {
      ...legacy,
      commandId: asSessionCommandId('command:canonical-send'),
      kind: 'send_message' as const,
      correlationId: asCorrelationId('correlation:canonical-send'),
    };
    expect(store.acceptCommand({
      command: canonical,
      payloadHash: hashControlPlanePayload(payload),
      legacySessionId: 8,
      idempotencyKindAliases: ['start'],
    })).toMatchObject({
      kind: 'existing',
      command: {
        commandId: legacy.commandId,
        kind: 'start',
      },
    });
    expect(store.acceptCommand({
      command: { ...canonical, payload: { content: 'different' } },
      payloadHash: hashControlPlanePayload({ content: 'different' }),
      legacySessionId: 8,
      idempotencyKindAliases: ['start'],
    })).toMatchObject({
      kind: 'payload_conflict',
      command: { commandId: legacy.commandId },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_commands').get()).toEqual({ count: 1 });
    expect(db.prepare(
      'SELECT version FROM control_plane_sessions WHERE session_id = ?',
    ).get(sessionId)).toEqual({ version: 1 });
  });
});
