import { describe, expect, it } from 'vitest';
import { buildSessionIntent } from '../session-intent.js';
import type { SessionStore } from '../store.js';

interface StubState {
  title?: string | null;
  firstMsg?: string | null;
  latestMsg?: string | null;
  plans?: Array<{ status: string; plan_text: string }>;
  tasks?: { summary?: string; tasks: Array<{ status: string; title?: string; content?: string; id: string }> } | null;
}

function stubStore(state: StubState): SessionStore {
  return {
    getSession: () => (state.title !== undefined ? { title: state.title } : null),
    getFirstUserMessageText: () => state.firstMsg ?? null,
    getLatestNonMetaUserMessageText: () => state.latestMsg ?? null,
    listPlans: () => state.plans ?? [],
    getTasksState: () => state.tasks ?? null,
  } as unknown as SessionStore;
}

describe('buildSessionIntent', () => {
  it('returns null when there is nothing to say', () => {
    expect(buildSessionIntent(stubStore({}), 1)).toBeNull();
  });

  it('includes the original request only when the latest one matches', () => {
    const intent = buildSessionIntent(
      stubStore({ firstMsg: 'Fix the login bug', latestMsg: 'Fix the login bug' }),
      1,
    )!;
    expect(intent).toContain('Original request:\nFix the login bug');
    expect(intent).not.toContain('Latest request:');
  });

  it('surfaces a pivoted latest request distinct from the original', () => {
    const intent = buildSessionIntent(
      stubStore({ firstMsg: 'Add dark mode', latestMsg: 'Actually, add a settings page instead' }),
      1,
    )!;
    expect(intent).toContain('Original request:\nAdd dark mode');
    expect(intent).toContain('Latest request:\nActually, add a settings page instead');
  });

  it('includes an approved plan but ignores a pending one', () => {
    const approved = buildSessionIntent(
      stubStore({ firstMsg: 'x', plans: [{ status: 'approved', plan_text: 'Step 1\nStep 2' }] }),
      1,
    )!;
    expect(approved).toContain('Approved plan:\nStep 1\nStep 2');

    const pending = buildSessionIntent(
      stubStore({ firstMsg: 'x', plans: [{ status: 'pending', plan_text: 'draft' }] }),
      1,
    )!;
    expect(pending).not.toContain('Approved plan:');
  });

  it('degrades to null when the store throws', () => {
    const broken = {
      getSession: () => {
        throw new Error('boom');
      },
    } as unknown as SessionStore;
    expect(buildSessionIntent(broken, 1)).toBeNull();
  });
});
