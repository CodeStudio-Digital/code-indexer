import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createSessionSlice,
  type SessionSlice,
} from '@apps/dashboard/state/company/sessionSlice.js';
import type { CompanySession } from '@mcp/company-contracts';

type Store = UseBoundStore<StoreApi<SessionSlice>>;

const PARENT_ID = '00000000-0000-4000-8000-000000000005';
const CHILD_7_ID = '00000000-0000-4000-8000-000000000007';
const CHILD_8_ID = '00000000-0000-4000-8000-000000000008';
const CHILD_9_ID = '00000000-0000-4000-8000-000000000009';
const CHILD_10_ID = '00000000-0000-4000-8000-000000000010';
const CHILD_12_ID = '00000000-0000-4000-8000-000000000012';

function session(overrides: Partial<CompanySession> = {}): CompanySession {
  return {
    id: PARENT_ID,
    template_id: null,
    runtime_kind: 'company',
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
    const parent = session({ id: PARENT_ID, name: 'Main' });
    const children = [
      session({ id: CHILD_12_ID, name: 'late', parent_session_id: PARENT_ID }),
      session({ id: CHILD_8_ID, name: 'first', parent_session_id: PARENT_ID }),
    ];
    store.getState().sessionLoaded(PARENT_ID, parent, children);
    const slot = store.getState().siblings.get(PARENT_ID)!;
    expect(slot.parent?.id).toBe(PARENT_ID);
    expect(slot.children.map((c) => c.id)).toEqual([CHILD_8_ID, CHILD_12_ID]);
    expect(slot.activeSessionId).toBe(PARENT_ID);
    expect(slot.loading).toBe(false);
  });

  it('sessionLoaded preserves active when the id is still valid', () => {
    const parent = session({ id: PARENT_ID });
    store.getState().sessionLoaded(PARENT_ID, parent, [
      session({ id: CHILD_8_ID, parent_session_id: PARENT_ID }),
    ]);
    store.getState().sessionSetActive(PARENT_ID, CHILD_8_ID);
    store.getState().sessionLoaded(PARENT_ID, parent, [
      session({ id: CHILD_8_ID, parent_session_id: PARENT_ID }),
      session({ id: CHILD_9_ID, parent_session_id: PARENT_ID }),
    ]);
    expect(store.getState().siblings.get(PARENT_ID)!.activeSessionId).toBe(CHILD_8_ID);
  });

  it('sessionLoaded resets active when the id is gone', () => {
    const parent = session({ id: PARENT_ID });
    store.getState().sessionLoaded(PARENT_ID, parent, [
      session({ id: CHILD_8_ID, parent_session_id: PARENT_ID }),
    ]);
    store.getState().sessionSetActive(PARENT_ID, CHILD_8_ID);
    store.getState().sessionLoaded(PARENT_ID, parent, []);
    expect(store.getState().siblings.get(PARENT_ID)!.activeSessionId).toBe(PARENT_ID);
  });

  it('sessionUpsertChild adds + replaces by id, keeping order', () => {
    const parent = session({ id: PARENT_ID });
    store.getState().sessionLoaded(PARENT_ID, parent, []);
    store.getState().sessionUpsertChild(PARENT_ID, session({ id: CHILD_10_ID, name: 'a', parent_session_id: PARENT_ID }));
    store.getState().sessionUpsertChild(PARENT_ID, session({ id: CHILD_7_ID, name: 'b', parent_session_id: PARENT_ID }));
    store.getState().sessionUpsertChild(PARENT_ID, session({ id: CHILD_10_ID, name: 'a-renamed', parent_session_id: PARENT_ID }));
    const ids = store.getState().siblings.get(PARENT_ID)!.children.map((c) => c.id);
    expect(ids).toEqual([CHILD_7_ID, CHILD_10_ID]);
    expect(store.getState().siblings.get(PARENT_ID)!.children[1].name).toBe('a-renamed');
  });

  it('sessionRemoveChild falls back active to the parent when active is removed', () => {
    const parent = session({ id: PARENT_ID });
    store.getState().sessionLoaded(PARENT_ID, parent, [
      session({ id: CHILD_7_ID, parent_session_id: PARENT_ID }),
    ]);
    store.getState().sessionSetActive(PARENT_ID, CHILD_7_ID);
    store.getState().sessionRemoveChild(PARENT_ID, CHILD_7_ID);
    const slot = store.getState().siblings.get(PARENT_ID)!;
    expect(slot.children.map((c) => c.id)).toEqual([]);
    expect(slot.activeSessionId).toBe(PARENT_ID);
  });

  it('sessionRemoveChild keeps active untouched when removing a different child', () => {
    const parent = session({ id: PARENT_ID });
    store.getState().sessionLoaded(PARENT_ID, parent, [
      session({ id: CHILD_7_ID, parent_session_id: PARENT_ID }),
      session({ id: CHILD_8_ID, parent_session_id: PARENT_ID }),
    ]);
    store.getState().sessionSetActive(PARENT_ID, CHILD_7_ID);
    store.getState().sessionRemoveChild(PARENT_ID, CHILD_8_ID);
    expect(store.getState().siblings.get(PARENT_ID)!.activeSessionId).toBe(CHILD_7_ID);
  });

  it('sessionReset drops the slot', () => {
    store.getState().sessionLoaded(PARENT_ID, session({ id: PARENT_ID }), []);
    store.getState().sessionReset(PARENT_ID);
    expect(store.getState().siblings.has(PARENT_ID)).toBe(false);
  });
});
