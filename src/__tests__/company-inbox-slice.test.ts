import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createInboxSlice,
  type InboxSlice,
} from '@apps/dashboard/state/company/inboxSlice.js';
import type { AgentInboxMessage } from '@mcp/company-contracts';

type Store = UseBoundStore<StoreApi<InboxSlice>>;

function msg(overrides: Partial<AgentInboxMessage> = {}): AgentInboxMessage {
  return {
    id: 1,
    company_session_id: 42,
    from_agent_run_id: 100,
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
    store.getState().inboxHydrate(42, [msg({ id: 1 }), msg({ id: 2, body: 'second' })]);
    const slot = store.getState().inbox.get(42)!;
    expect(slot.initialized).toBe(true);
    expect(slot.messagesById.size).toBe(2);
    expect(slot.messagesById.get(2)?.body).toBe('second');
  });

  it('bumpEventSeq increments monotonically', () => {
    store.getState().inboxBumpEventSeq(42);
    store.getState().inboxBumpEventSeq(42);
    store.getState().inboxBumpEventSeq(42);
    expect(store.getState().inbox.get(42)!.lastEventSeq).toBe(3);
  });

  it('bumpEventSeq from zero auto-creates the slot', () => {
    expect(store.getState().inbox.has(42)).toBe(false);
    store.getState().inboxBumpEventSeq(42);
    expect(store.getState().inbox.get(42)!.lastEventSeq).toBe(1);
  });

  it('setLoading and setError are isolated', () => {
    store.getState().inboxSetLoading(42, true);
    store.getState().inboxSetError(42, 'oops');
    const slot = store.getState().inbox.get(42)!;
    expect(slot.loading).toBe(true);
    expect(slot.error).toBe('oops');
  });

  it('reset drops the slot', () => {
    store.getState().inboxHydrate(42, [msg()]);
    store.getState().inboxReset(42);
    expect(store.getState().inbox.has(42)).toBe(false);
  });
});
