import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import {
  acceptLocalCoderCommand,
  bindLocalCommandBus,
  drainLocalCoderShadowWrites,
  fingerprintLocalCoderMessage,
  markLocalCoderRunStarted,
  mirrorLocalCoderLifecycleEvent,
  mirrorLocalCoderToolBoundary,
  terminalizeLocalCoderCommand,
  terminalizeLocalCoderRun,
} from '@apps/http-api/control-plane-shadow.js';
import { controlPlaneFoundation251 } from '../../migrations/251_control_plane_foundation.js';
import { controlPlaneAlignment252 } from '../../migrations/252_control_plane_alignment.js';
import { ControlPlaneStore } from '../control-plane-store.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const SECRETS = [
  'SECRET-USER-MESSAGE',
  'SECRET-ATTACHMENT',
  'SECRET-TOOL-INPUT',
  'SECRET-TOOL-RESULT',
  'SECRET-ERROR-MESSAGE',
];

describe('journal privacy', () => {
  let db: DB;
  let previousControlPlane: string | undefined;
  let previousJournal: string | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
    controlPlaneFoundation251.up(db);
    controlPlaneAlignment252.up(db);
    db.prepare('INSERT INTO coder_sessions(id) VALUES (?)').run(21);
    previousControlPlane = process.env.CODER_CONTROL_PLANE_SHADOW;
    previousJournal = process.env.CODER_RUNTIME_JOURNAL_SHADOW;
    process.env.CODER_CONTROL_PLANE_SHADOW = '1';
    process.env.CODER_RUNTIME_JOURNAL_SHADOW = '1';
  });

  afterEach(() => {
    db.close();
    if (previousControlPlane === undefined) delete process.env.CODER_CONTROL_PLANE_SHADOW;
    else process.env.CODER_CONTROL_PLANE_SHADOW = previousControlPlane;
    if (previousJournal === undefined) delete process.env.CODER_RUNTIME_JOURNAL_SHADOW;
    else process.env.CODER_RUNTIME_JOURNAL_SHADOW = previousJournal;
  });

  it('never persists raw user content, tool values or error text in runtime_events', async () => {
    const store = new ControlPlaneStore(db, { journalEnabled: true });
    const acceptance = acceptLocalCoderCommand({
      store,
      legacySessionId: 21,
      kind: 'start',
      idempotencyKey: 'msg:privacy:1',
      fingerprint: fingerprintLocalCoderMessage({
        content: 'SECRET-USER-MESSAGE',
        attachments: [{ name: 'report.pdf', mediaType: 'application/pdf', base64: 'SECRET-ATTACHMENT' }],
        agent: 'build',
      }),
      createRun: true,
      role: 'build',
      agentDefinitionId: 'build',
      requestedCapabilityProfile: 'auto',
    });
    expect(acceptance?.outcome).toBe('accepted');
    expect(acceptance?.runContext).toBeDefined();
    const context = acceptance!.runContext!;

    markLocalCoderRunStarted(store, context, 'runner:21');
    const writes = [mirrorLocalCoderToolBoundary(store, context, {
      phase: 'started',
      toolUseId: 'tu-1',
      toolName: 'edit_file',
      value: { secret: 'SECRET-TOOL-INPUT' },
    }), mirrorLocalCoderToolBoundary(store, context, {
      phase: 'completed',
      toolUseId: 'tu-1',
      toolName: 'edit_file',
      value: 'SECRET-TOOL-RESULT',
      durationMs: 5,
    }), mirrorLocalCoderLifecycleEvent(store, context, {
      type: 'provider.swapped',
      payload: { provider: 'kimi', model: 'k2' },
    })];
    await Promise.all(writes);
    await drainLocalCoderShadowWrites();
    terminalizeLocalCoderRun(store, context, {
      event: 'error',
      data: { message: 'SECRET-ERROR-MESSAGE', reason: 'error' },
    });

    const rows = db.prepare(`
      SELECT event_type AS type, payload_json AS payload, actor_json AS actor, redaction_json AS redaction
      FROM runtime_events
    `).all() as Array<{ type: string; payload: string; actor: string; redaction: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const serialized = rows
      .map((row) => [row.type, row.payload, row.actor, row.redaction].join('|'))
      .join('\n');

    for (const secret of SECRETS) {
      expect(serialized, `journal leaked ${secret}`).not.toContain(secret);
    }
    // Positive control: opaque hashes and structural metadata ARE persisted.
    expect(serialized).toContain('valueHash');
    expect(serialized).toContain('error:sha256:');
    expect(serialized).toContain('provider.swapped');
  });

  it('terminalizes an already accepted run even if the shadow flag is disabled later', () => {
    const store = new ControlPlaneStore(db, { journalEnabled: true });
    const acceptance = acceptLocalCoderCommand({
      store,
      legacySessionId: 21,
      kind: 'start',
      idempotencyKey: 'msg:toggle:1',
      fingerprint: fingerprintLocalCoderMessage({ content: 'run once' }),
      createRun: true,
      role: 'build',
      agentDefinitionId: 'build',
      requestedCapabilityProfile: 'auto',
    });
    const context = acceptance?.runContext;
    expect(context).toBeDefined();

    markLocalCoderRunStarted(store, context, 'runner:toggle');
    process.env.CODER_CONTROL_PLANE_SHADOW = '0';
    terminalizeLocalCoderRun(store, context, {
      event: 'done',
      data: { reason: 'completed' },
    });

    expect(store.commands.get(context!.commandId)).toMatchObject({
      status: 'succeeded',
      reasonCode: 'completed',
    });
    expect(store.runs.get(context!.agentRunId)).toMatchObject({ status: 'completed' });
    expect(store.runs.getAttempt(context!.attemptId)).toMatchObject({
      status: 'terminal',
      executorLease: expect.objectContaining({ status: 'released' }),
    });
  });

  it('persists one immutable command-to-bus binding through terminalization', () => {
    const store = new ControlPlaneStore(db, { journalEnabled: true });
    const acceptance = acceptLocalCoderCommand({
      store,
      legacySessionId: 21,
      kind: 'send_message',
      idempotencyKey: 'msg:bus:1',
      fingerprint: fingerprintLocalCoderMessage({ content: 'send once' }),
      createRun: false,
      role: 'build',
      agentDefinitionId: 'build',
      requestedCapabilityProfile: 'auto',
    });
    expect(acceptance?.outcome).toBe('accepted');

    expect(bindLocalCommandBus(store, acceptance, 'bus:original')).toBe(true);
    expect(bindLocalCommandBus(store, acceptance, 'bus:original')).toBe(true);
    expect(bindLocalCommandBus(store, acceptance, 'bus:replacement')).toBe(false);
    terminalizeLocalCoderCommand(store, acceptance, {
      status: 'succeeded',
      reason: 'completed',
    });

    expect(store.commands.get(acceptance!.commandContext!.commandId)).toMatchObject({
      status: 'succeeded',
      result: { busId: 'bus:original' },
    });
  });
});
