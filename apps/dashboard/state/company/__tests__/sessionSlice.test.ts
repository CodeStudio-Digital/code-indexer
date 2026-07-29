import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { CompanySession } from '@mcp/company-contracts';
import { createSessionSlice, type SessionSlice } from '../sessionSlice.js';

const ROOT_ID = '10000000-0000-4000-8000-000000000000';
const CHILD_A_ID = '20000000-0000-4000-8000-000000000000';
const CHILD_B_ID = '30000000-0000-4000-8000-000000000000';
const CHILD_C_ID = '40000000-0000-4000-8000-000000000000';

function session(
  id: string,
  createdAt: string,
  parentSessionId: string | null = null,
): CompanySession {
  return {
    id,
    template_id: null,
    runtime_kind: 'company',
    name: `session-${id.slice(0, 4)}`,
    status: 'idle',
    master_session_id: null,
    config_json: '{}',
    parent_session_id: parentSessionId,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function createTestStore() {
  return createStore<SessionSlice>()((...args) => createSessionSlice(...args));
}

describe('sessionSlice UUID identity', () => {
  it('orders children by creation time and UUID without numeric id arithmetic', () => {
    const store = createTestStore();
    const parent = session(ROOT_ID, '2026-07-27T10:00:00.000Z');
    const first = session(CHILD_B_ID, '2026-07-27T10:01:00.000Z', ROOT_ID);
    const tiedLaterUuid = session(CHILD_C_ID, '2026-07-27T10:02:00.000Z', ROOT_ID);
    const tiedEarlierUuid = session(CHILD_A_ID, '2026-07-27T10:02:00.000Z', ROOT_ID);

    store
      .getState()
      .sessionLoaded(ROOT_ID, parent, [tiedLaterUuid, first, tiedEarlierUuid]);

    expect(store.getState().siblings.get(ROOT_ID)?.children.map((child) => child.id)).toEqual([
      CHILD_B_ID,
      CHILD_A_ID,
      CHILD_C_ID,
    ]);
  });

  it('preserves a valid active UUID and falls back to the parent after removal', () => {
    const store = createTestStore();
    const parent = session(ROOT_ID, '2026-07-27T10:00:00.000Z');
    const child = session(CHILD_A_ID, '2026-07-27T10:01:00.000Z', ROOT_ID);

    store.getState().sessionLoaded(ROOT_ID, parent, [child]);
    store.getState().sessionSetActive(ROOT_ID, CHILD_A_ID);
    store.getState().sessionLoaded(ROOT_ID, parent, [child]);
    expect(store.getState().siblings.get(ROOT_ID)?.activeSessionId).toBe(CHILD_A_ID);

    store.getState().sessionRemoveChild(ROOT_ID, CHILD_A_ID);
    expect(store.getState().siblings.get(ROOT_ID)?.activeSessionId).toBe(ROOT_ID);
  });

  it('upserts children by opaque UUID and keeps the canonical order', () => {
    const store = createTestStore();
    const parent = session(ROOT_ID, '2026-07-27T10:00:00.000Z');
    const later = session(CHILD_C_ID, '2026-07-27T10:03:00.000Z', ROOT_ID);
    const earlier = session(CHILD_A_ID, '2026-07-27T10:01:00.000Z', ROOT_ID);

    store.getState().sessionLoaded(ROOT_ID, parent, [later]);
    store.getState().sessionUpsertChild(ROOT_ID, earlier);
    store.getState().sessionUpsertChild(ROOT_ID, {
      ...later,
      name: 'renamed',
    });

    const children = store.getState().siblings.get(ROOT_ID)?.children ?? [];
    expect(children.map((child) => child.id)).toEqual([CHILD_A_ID, CHILD_C_ID]);
    expect(children[1]?.name).toBe('renamed');
  });
});
