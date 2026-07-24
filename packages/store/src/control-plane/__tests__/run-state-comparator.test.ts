import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { asSessionId } from '@mcp/agent-runtime-contracts';
import { controlPlaneFoundation251 } from '../../migrations/251_control_plane_foundation.js';
import { controlPlaneAlignment252 } from '../../migrations/252_control_plane_alignment.js';
import { ControlPlaneDivergenceStore } from '../divergence-store.js';
import { compareRunTerminalState } from '../run-state-comparator.js';

const DONE = { event: 'done' as const, reason: 'completed' };
const ERROR = { event: 'error' as const, reason: 'error' };

describe('compareRunTerminalState', () => {
  it('returns no divergences when legacy and control plane agree', () => {
    expect(compareRunTerminalState({
      legacy: DONE,
      command: { status: 'succeeded', reasonCode: 'completed', agentRunId: undefined },
      run: null,
    })).toEqual([]);
    expect(compareRunTerminalState({
      legacy: DONE,
      command: { status: 'succeeded', reasonCode: 'completed', agentRunId: 'run:1' as never },
      run: { status: 'completed', terminalReason: 'completed' },
    })).toEqual([]);
    expect(compareRunTerminalState({
      legacy: ERROR,
      command: { status: 'failed', reasonCode: 'worker-crashed', agentRunId: 'run:1' as never },
      run: { status: 'interrupted', terminalReason: 'worker-crashed' },
    })).toEqual([]);
    expect(compareRunTerminalState({
      legacy: { event: 'done', reason: 'max_turns' },
      command: { status: 'failed', reasonCode: 'max_turns', agentRunId: 'run:2' as never },
      run: { status: 'interrupted', terminalReason: 'max_turns' },
    })).toEqual([]);
  });

  it('flags a missing command and, when linked, a missing run', () => {
    const missing = compareRunTerminalState({ legacy: DONE, command: null, run: null });
    expect(missing).toHaveLength(1);
    expect(missing[0].kind).toBe('missing_command');

    const missingRun = compareRunTerminalState({
      legacy: DONE,
      command: { status: 'succeeded', reasonCode: 'completed', agentRunId: 'run:gone' as never },
      run: null,
    });
    expect(missingRun).toHaveLength(1);
    expect(missingRun[0].kind).toBe('missing_run');
  });

  it('flags terminal mismatches between legacy and control plane', () => {
    const divergences = compareRunTerminalState({
      legacy: DONE,
      command: { status: 'failed', reasonCode: 'boom', agentRunId: 'run:1' as never },
      run: { status: 'failed', terminalReason: 'boom' },
    });
    expect(divergences.map((d) => d.kind)).toEqual([
      'command_status_mismatch',
      'run_status_mismatch',
    ]);
    expect(divergences[0].detail).toContain('expected one of succeeded');
    expect(divergences[1].detail).toContain('expected one of completed');
  });

  it('flags non-terminal control-plane rows after a legacy terminal event', () => {
    const divergences = compareRunTerminalState({
      legacy: ERROR,
      command: { status: 'running', reasonCode: undefined, agentRunId: 'run:1' as never },
      run: { status: 'running', terminalReason: undefined },
    });
    expect(divergences.map((d) => d.kind)).toEqual([
      'command_not_terminal',
      'run_not_terminal',
    ]);
  });
});

describe('ControlPlaneDivergenceStore', () => {
  type DB = InstanceType<typeof DatabaseConstructor>;
  let db: DB;
  let store: ControlPlaneDivergenceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
    controlPlaneFoundation251.up(db);
    controlPlaneAlignment252.up(db);
    db.prepare(`
      INSERT INTO control_plane_sessions (session_id, version, created_at, updated_at)
      VALUES ('session:test', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    store = new ControlPlaneDivergenceStore(db);
  });

  afterEach(() => db.close());

  it('persists divergences once per entity+kind and lists/counts them', () => {
    const divergences = compareRunTerminalState({
      legacy: DONE,
      command: { status: 'failed', reasonCode: 'boom', agentRunId: 'run:1' as never },
      run: { status: 'failed', terminalReason: 'boom' },
    });
    const context = {
      sessionId: asSessionId('session:test'),
      commandId: 'command:1' as never,
      agentRunId: 'run:1' as never,
    };

    expect(store.recordMany(context, divergences, '2026-01-02T00:00:00.000Z')).toBe(2);
    expect(store.recordMany(context, divergences, '2026-01-03T00:00:00.000Z')).toBe(0);
    expect(store.count()).toBe(2);

    const listed = store.list('session:test');
    expect(listed).toHaveLength(2);
    expect(listed.map((row) => row.kind).sort()).toEqual([
      'command_status_mismatch',
      'run_status_mismatch',
    ]);
    expect(listed[0]).toMatchObject({
      sessionId: 'session:test',
      commandId: 'command:1',
      agentRunId: 'run:1',
      legacyState: DONE,
    });
  });
});
