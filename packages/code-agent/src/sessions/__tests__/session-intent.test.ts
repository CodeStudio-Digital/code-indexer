import { describe, expect, it } from 'vitest';
import { asSessionId, type SessionId } from '@mcp/session-storage';
import {
  buildSessionIntent,
  type SessionIntentStore,
} from '../session-intent.js';

interface StubState {
  title?: string | null;
  firstMsg?: string | null;
  latestMsg?: string | null;
  plans?: Array<{ status: string; plan_text: string }>;
  tasks?: { summary?: string; tasks: Array<{ status: string; title?: string; content?: string; id: string }> } | null;
}

const SESSION_ID = asSessionId('00000000-0000-4000-8000-000000000001');

function stubStore(state: StubState): SessionIntentStore<SessionId> {
  return {
    getSession: () => (state.title !== undefined ? { title: state.title } : null),
    getFirstUserMessageText: () => state.firstMsg ?? null,
    getLatestNonMetaUserMessageText: () => state.latestMsg ?? null,
    listPlans: () => state.plans ?? [],
    getTasksState: () => state.tasks ?? null,
  };
}

describe('buildSessionIntent', () => {
  it('returns null when there is nothing to say', async () => {
    await expect(buildSessionIntent(stubStore({}), SESSION_ID)).resolves.toBeNull();
  });

  it('includes the original request only when the latest one matches', async () => {
    const intent = (await buildSessionIntent(
      stubStore({ firstMsg: 'Fix the login bug', latestMsg: 'Fix the login bug' }),
      SESSION_ID,
    ))!;
    expect(intent).toContain('Original request:\nFix the login bug');
    expect(intent).not.toContain('Latest request:');
  });

  it('surfaces a pivoted latest request distinct from the original', async () => {
    const intent = (await buildSessionIntent(
      stubStore({ firstMsg: 'Add dark mode', latestMsg: 'Actually, add a settings page instead' }),
      SESSION_ID,
    ))!;
    expect(intent).toContain('Original request:\nAdd dark mode');
    expect(intent).toContain('Latest request:\nActually, add a settings page instead');
  });

  it('includes an approved plan but ignores a pending one', async () => {
    const approved = (await buildSessionIntent(
      stubStore({ firstMsg: 'x', plans: [{ status: 'approved', plan_text: 'Step 1\nStep 2' }] }),
      SESSION_ID,
    ))!;
    expect(approved).toContain('Approved plan:\nStep 1\nStep 2');

    const pending = (await buildSessionIntent(
      stubStore({ firstMsg: 'x', plans: [{ status: 'pending', plan_text: 'draft' }] }),
      SESSION_ID,
    ))!;
    expect(pending).not.toContain('Approved plan:');
  });

  it('degrades to null when the store throws', async () => {
    const broken = {
      getSession: () => {
        throw new Error('boom');
      },
    } as unknown as SessionIntentStore<SessionId>;
    await expect(buildSessionIntent(broken, SESSION_ID)).resolves.toBeNull();
  });
});
