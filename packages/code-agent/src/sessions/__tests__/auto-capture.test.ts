/**
 * Auto-captured session notes — event filtering, canonical titles, the
 * error-streak tracker, and the enabled=false no-op. Store is a fake (no
 * filesystem I/O); upsert semantics are the repository's concern.
 */
import { describe, it, expect } from 'vitest';
import { newSessionId } from '@mcp/session-storage';
import { buildAutoCapture, type AutoCaptureStore } from '../auto-capture.js';

const SESSION_ID = newSessionId();

function fakeStore(): AutoCaptureStore & { saved: Array<{ title: string; body: string; kind?: string }> } {
  const saved: Array<{ title: string; body: string; kind?: string }> = [];
  return {
    saved,
    async rememberMemory(_sid, input) {
      saved.push(input);
      return { title: input.title };
    },
  };
}

function capture(over: { enabled?: boolean; isRepeatable?: (n: string) => boolean } = {}) {
  const store = fakeStore();
  const ac = buildAutoCapture({
    store,
    sessionId: SESSION_ID,
    enabled: over.enabled ?? true,
    isRepeatable: over.isRepeatable,
  });
  return { store, ac };
}

describe('buildAutoCapture', () => {
  it('captures an APPROVED plan with the canonical title', () => {
    const { store, ac } = capture();
    ac.onPlanResolved('approved', 'do X then Y', 'looks good');
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({ title: 'Approved plan', kind: 'auto:plan' });
    expect(store.saved[0].body).toContain('do X then Y');
    expect(store.saved[0].body).toContain('looks good');
  });

  it('ignores rejected plans and missing text', () => {
    const { store, ac } = capture();
    ac.onPlanResolved('rejected', 'plan text');
    ac.onPlanResolved('approved', null);
    expect(store.saved).toHaveLength(0);
  });

  it('captures goal COMPLETION only (creation is structural)', () => {
    const { store, ac } = capture();
    ac.onGoalUpserted({ text: 'ship it', status: 'in_progress' });
    expect(store.saved).toHaveLength(0);
    ac.onGoalUpserted({ text: 'ship it', status: 'complete', completionNote: 'all green' });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({ title: 'Goal completed', kind: 'auto:goal' });
    expect(store.saved[0].body).toContain('all green');
  });

  it('captures task closures that carry a summary, skipping silent ones', () => {
    const { store, ac } = capture();
    ac.onTaskStatus('tsk_1', { status: 'in_progress' });
    ac.onTaskStatus('tsk_1', { status: 'done' }); // no summary → no signal
    expect(store.saved).toHaveLength(0);
    ac.onTaskStatus('tsk_1', {
      status: 'done',
      result: { summary: 'implemented the mutex', files_modified: ['a.ts', 'b.ts'] },
    });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({ title: 'Task tsk_1', kind: 'auto:task' });
    expect(store.saved[0].body).toContain('done: implemented the mutex');
    expect(store.saved[0].body).toContain('a.ts, b.ts');
  });

  it('mints a "Fixed:" note only when a ≥3-error streak resolves', () => {
    const { store, ac } = capture();
    ac.onToolResult('run_command', true, 'ENOENT', 1, 'run_command:missing-file');
    ac.onToolResult('run_command', true, 'ENOENT', 2, 'run_command:missing-file');
    ac.onToolResult('run_command', false, '', 3, 'run_command:missing-file'); // streak of 2 — below threshold
    expect(store.saved).toHaveLength(0);

    ac.onToolResult('run_command', true, 'vitest: not found', 4, 'run_command:vitest');
    ac.onToolResult('run_command', true, 'vitest: not found', 5, 'run_command:vitest');
    ac.onToolResult('run_command', true, 'vitest: not found', 6, 'run_command:vitest');
    ac.onToolResult('run_command', false, '', 7, 'run_command:vitest');
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({ title: 'Fixed: run_command', kind: 'auto:fix' });
    expect(store.saved[0].body).toContain('After 3 consecutive failures');
    expect(store.saved[0].body).toContain('turn 7');
    expect(store.saved[0].body).toContain('vitest: not found');
  });

  it('does not resolve failures from unrelated logical operations of the same tool', () => {
    const { store, ac } = capture();
    ac.onToolResult('run_command', true, 'server start timed out', 1, 'run_command:start-a');
    ac.onToolResult('run_command', true, 'server start timed out', 2, 'run_command:start-b');
    ac.onToolResult('run_command', true, 'smoke fetch failed', 3, 'run_command:smoke');

    // A different command succeeding is not proof that any failure above was fixed.
    ac.onToolResult('run_command', false, '', 4, 'run_command:unit-tests');
    expect(store.saved).toHaveLength(0);
  });

  it('exempts repeatable/polling tools from streak notes', () => {
    const { store, ac } = capture({ isRepeatable: (n) => n === 'wait_status' });
    for (let i = 0; i < 5; i++) ac.onToolResult('wait_status', true, 'pending', i);
    ac.onToolResult('wait_status', false, '', 6);
    expect(store.saved).toHaveLength(0);
  });

  it('enabled=false is a total no-op', () => {
    const { store, ac } = capture({ enabled: false });
    ac.onPlanResolved('approved', 'plan');
    ac.onGoalUpserted({ text: 'g', status: 'complete' });
    ac.onTaskStatus('t', { status: 'done', result: { summary: 's' } });
    for (let i = 0; i < 4; i++) ac.onToolResult('x', true, 'e', i);
    ac.onToolResult('x', false, '', 5);
    expect(store.saved).toHaveLength(0);
  });

  it('never throws when the store write fails', () => {
    const boom: AutoCaptureStore = {
      async rememberMemory() { throw new Error('bundle unavailable'); },
    };
    const ac = buildAutoCapture({
      store: boom,
      sessionId: SESSION_ID,
      enabled: true,
    });
    expect(() => ac.onPlanResolved('approved', 'plan')).not.toThrow();
  });
});
