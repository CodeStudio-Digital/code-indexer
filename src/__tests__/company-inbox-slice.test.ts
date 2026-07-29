import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createInboxSlice,
  type InboxSlice,
} from '@apps/dashboard/state/company/inboxSlice.js';
import type { AgentInboxMessage } from '@mcp/company-contracts';

type Store = UseBoundStore<StoreApi<InboxSlice>>;

const SESSION_ID = '00000000-0000-4000-8000-000000000042';
const RUN_ID = '00000000-0000-4000-8000-000000000100';
const MESSAGE_1_ID = '00000000-0000-4000-8000-000000000201';
const MESSAGE_2_ID = '00000000-0000-4000-8000-000000000202';

function msg(overrides: Partial<AgentInboxMessage> = {}): AgentInboxMessage {
  return {
    id: MESSAGE_1_ID,
    seq: 1,
    company_session_id: SESSION_ID,
    from_agent_run_id: RUN_ID,
    from_role: 'master',
    to_role: 'reviewer',
    to_agent_run_id: null,
    kind: 'question',
    body: 'hello',
    status: 'pending',
    answer: null,
    wait_token: null,
    created_at: '2025-01-01',
    delivered_at: null,
    answered_at: null,
    ...overrides,
  };
}

function makeStore(): Store {
  return create<InboxSlice>()(createInboxSlice);
}

describe('inboxSlice', () => {
  let store: Store;

  beforeEach(() => {
    store = makeStore();
  });

  it('hydrate replaces the message map and flips initialized', () => {
    store.getState().inboxHydrate(SESSION_ID, [
      msg({ id: MESSAGE_1_ID }),
      msg({ id: MESSAGE_2_ID, body: 'second' }),
    ]);
    const slot = store.getState().inbox.get(SESSION_ID)!;
    expect(slot.initialized).toBe(true);
    expect(slot.messagesById.size).toBe(2);
    expect(slot.messagesById.get(MESSAGE_2_ID)?.body).toBe('second');
  });

  it('bumpEventSeq increments monotonically', () => {
    store.getState().inboxBumpEventSeq(SESSION_ID);
    store.getState().inboxBumpEventSeq(SESSION_ID);
    store.getState().inboxBumpEventSeq(SESSION_ID);
    expect(store.getState().inbox.get(SESSION_ID)!.lastEventSeq).toBe(3);
  });

  it('bumpEventSeq from zero auto-creates the slot', () => {
    expect(store.getState().inbox.has(SESSION_ID)).toBe(false);
    store.getState().inboxBumpEventSeq(SESSION_ID);
    expect(store.getState().inbox.get(SESSION_ID)!.lastEventSeq).toBe(1);
  });

  it('setLoading and setError are isolated', () => {
    store.getState().inboxSetLoading(SESSION_ID, true);
    store.getState().inboxSetError(SESSION_ID, 'oops');
    const slot = store.getState().inbox.get(SESSION_ID)!;
    expect(slot.loading).toBe(true);
    expect(slot.error).toBe('oops');
  });

  it('reset drops the slot', () => {
    store.getState().inboxHydrate(SESSION_ID, [msg()]);
    store.getState().inboxReset(SESSION_ID);
    expect(store.getState().inbox.has(SESSION_ID)).toBe(false);
  });
});
