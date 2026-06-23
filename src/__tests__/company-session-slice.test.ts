import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createSessionSlice,
  type SessionSlice,
} from '@apps/dashboard/state/company/sessionSlice.js';
import type { CompanySession } from '@mcp/company-contracts';

type Store = UseBoundStore<StoreApi<SessionSlice>>;

function session(overrides: Partial<CompanySession> = {}): CompanySession {
  return {
    id: 1,
    template_id: null,
    name: 'Main',
    status: 'idle',
    master_session_id: null,
    config_json: '{}',
    parent_session_id: null,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    ...overrides,
  };
}

function makeStore(): Store {
  return create<SessionSlice>()(createSessionSlice);
}

describe('sessionSlice', () => {
  let store: Store;

  beforeEach(() => {
    store = makeStore();
  });

  it('sessionLoaded sorts children by id and defaults active to parent', () => {
    const parent = session({ id: 5, name: 'Main' });
    const children = [
      session({ id: 12, name: 'late', parent_session_id: 5 }),
      session({ id: 8, name: 'first', parent_session_id: 5 }),
    ];
    store.getState().sessionLoaded(5, parent, children);
    const slot = store.getState().siblings.get(5)!;
    expect(slot.parent?.id).toBe(5);
    expect(slot.children.map((c) => c.id)).toEqual([8, 12]);
    expect(slot.activeSessionId).toBe(5);
    expect(slot.loading).toBe(false);
  });

  it('sessionLoaded preserves active when the id is still valid', () => {
    const parent = session({ id: 5 });
    store.getState().sessionLoaded(5, parent, [session({ id: 8, parent_session_id: 5 })]);
    store.getState().sessionSetActive(5, 8);
    store.getState().sessionLoaded(5, parent, [
      session({ id: 8, parent_session_id: 5 }),
      session({ id: 9, parent_session_id: 5 }),
    ]);
    expect(store.getState().siblings.get(5)!.activeSessionId).toBe(8);
  });

  it('sessionLoaded resets active when the id is gone', () => {
    const parent = session({ id: 5 });
    store.getState().sessionLoaded(5, parent, [session({ id: 8, parent_session_id: 5 })]);
    store.getState().sessionSetActive(5, 8);
    store.getState().sessionLoaded(5, parent, []);
    expect(store.getState().siblings.get(5)!.activeSessionId).toBe(5);
  });

  it('sessionUpsertChild adds + replaces by id, keeping order', () => {
    const parent = session({ id: 5 });
    store.getState().sessionLoaded(5, parent, []);
    store.getState().sessionUpsertChild(5, session({ id: 10, name: 'a', parent_session_id: 5 }));
    store.getState().sessionUpsertChild(5, session({ id: 7, name: 'b', parent_session_id: 5 }));
    store.getState().sessionUpsertChild(5, session({ id: 10, name: 'a-renamed', parent_session_id: 5 }));
    const ids = store.getState().siblings.get(5)!.children.map((c) => c.id);
    expect(ids).toEqual([7, 10]);
    expect(store.getState().siblings.get(5)!.children[1].name).toBe('a-renamed');
  });

  it('sessionRemoveChild falls back active to the parent when active is removed', () => {
    const parent = session({ id: 5 });
    store.getState().sessionLoaded(5, parent, [session({ id: 7, parent_session_id: 5 })]);
    store.getState().sessionSetActive(5, 7);
    store.getState().sessionRemoveChild(5, 7);
    const slot = store.getState().siblings.get(5)!;
    expect(slot.children.map((c) => c.id)).toEqual([]);
    expect(slot.activeSessionId).toBe(5);
  });

  it('sessionRemoveChild keeps active untouched when removing a different child', () => {
    const parent = session({ id: 5 });
    store.getState().sessionLoaded(5, parent, [
      session({ id: 7, parent_session_id: 5 }),
      session({ id: 8, parent_session_id: 5 }),
    ]);
    store.getState().sessionSetActive(5, 7);
    store.getState().sessionRemoveChild(5, 8);
    expect(store.getState().siblings.get(5)!.activeSessionId).toBe(7);
  });

  it('sessionReset drops the slot', () => {
    store.getState().sessionLoaded(5, session({ id: 5 }), []);
    store.getState().sessionReset(5);
    expect(store.getState().siblings.has(5)).toBe(false);
  });
});
