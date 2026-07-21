import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { SessionStore } from '../../sessions/store.js';
import {
  resolveAndPersistRunCoderExecutionPolicy,
  type RunCoderExecutionResolution,
} from '../../index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function resolveWithCallLog(input: {
  mode?: 'standard' | 'ultra' | null;
  storedEffort?: string | null;
  executionMode?: 'standard' | 'ultra';
  reasoningEffort?: string;
}): { result: RunCoderExecutionResolution; calls: string[] } {
  const calls: string[] = [];
  const result = resolveAndPersistRunCoderExecutionPolicy(
    {
      setSessionExecutionMode: (_id, mode) => calls.push(`mode:${mode}`),
      setSessionReasoningEffort: (_id, effort) => calls.push(`effort:${effort ?? 'null'}`),
    },
    {
      id: 7,
      execution_mode_override: input.mode ?? 'standard',
      reasoning_effort_override: input.storedEffort ?? null,
    },
    {
      executionMode: input.executionMode,
      reasoningEffort: input.reasoningEffort,
    },
  );
  return { result, calls };
}

describe('direct runCoder execution contract', () => {
  it('persists an explicit mode and keeps a native Standard effort', () => {
    const { result, calls } = resolveWithCallLog({
      executionMode: 'standard',
      reasoningEffort: ' high ',
    });

    expect(calls).toEqual(['mode:standard']);
    expect(result).toEqual({
      sessionExecutionMode: 'standard',
      storedReasoningEffort: null,
      policy: { ultraEnabled: false, reasoningEffort: 'high' },
    });
  });

  it('lets an explicit Standard mode override the legacy Ultra spelling', () => {
    const { result, calls } = resolveWithCallLog({
      executionMode: 'standard',
      reasoningEffort: ' Ultra ',
    });

    expect(calls).toEqual(['mode:standard']);
    expect(result.policy).toEqual({
      ultraEnabled: false,
      reasoningEffort: undefined,
    });
  });

  it('upgrades a legacy Ultra request without persisting an effort sentinel', () => {
    const { result, calls } = resolveWithCallLog({ reasoningEffort: 'ultra' });

    expect(calls).toEqual(['mode:ultra']);
    expect(result.policy).toEqual({
      ultraEnabled: true,
      reasoningEffort: 'ultra',
    });
    expect(result.storedReasoningEffort).toBeNull();
  });

  it('repairs a stored legacy sentinel after persisting its Ultra mode', () => {
    const { result, calls } = resolveWithCallLog({ storedEffort: ' ULTRA ' });

    expect(calls).toEqual(['mode:ultra', 'effort:null']);
    expect(result.sessionExecutionMode).toBe('ultra');
    expect(result.storedReasoningEffort).toBeNull();
  });
});

describe('direct runCoder execution persistence', () => {
  let db: DB | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('writes the derived Ultra mode through SessionStore and leaves no sentinel', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY,
        execution_mode_override TEXT NOT NULL DEFAULT 'standard',
        reasoning_effort_override TEXT,
        updated_at TEXT
      );
      INSERT INTO coder_sessions (id) VALUES (1);
    `);
    const store = new SessionStore(db);

    const result = resolveAndPersistRunCoderExecutionPolicy(
      store,
      {
        id: 1,
        execution_mode_override: 'standard',
        reasoning_effort_override: null,
      },
      { reasoningEffort: 'ultra' },
    );

    expect(result.policy.ultraEnabled).toBe(true);
    expect(db.prepare(`
      SELECT execution_mode_override AS mode, reasoning_effort_override AS effort
        FROM coder_sessions WHERE id = 1
    `).get()).toEqual({ mode: 'ultra', effort: null });
  });
});
