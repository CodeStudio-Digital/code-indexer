import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createDriveSlice,
  type DriveFileMeta,
  type DriveSlice,
} from '@apps/dashboard/state/company/driveSlice.js';

type Store = UseBoundStore<StoreApi<DriveSlice>>;

const SESSION_ID = '00000000-0000-4000-8000-000000000042';
const FILE_1_ID = '00000000-0000-4000-8000-000000000101';
const FILE_2_ID = '00000000-0000-4000-8000-000000000102';
const FILE_10_ID = '00000000-0000-4000-8000-000000000110';

function file(overrides: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return {
    id: FILE_1_ID,
    scopeKey: `ses:${SESSION_ID}`,
    path: 'notes.md',
    sizeBytes: 32,
    mime: 'text/markdown',
    ownerRole: 'master',
    ownerAgentRunId: null,
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...overrides,
  };
}

function makeStore(): Store {
  return create<DriveSlice>()(createDriveSlice);
}

describe('driveSlice', () => {
  let store: Store;

  beforeEach(() => {
    store = makeStore();
  });

  it('starts empty until ensure is called', () => {
    expect(store.getState().drive.size).toBe(0);
    store.getState().driveEnsure(SESSION_ID);
    expect(store.getState().drive.get(SESSION_ID)?.initialized).toBe(false);
  });

  it('hydrate replaces the file map and sets initialized + scope', () => {
    store.getState().driveHydrate(SESSION_ID, `ses:${SESSION_ID}`, [
      file({ id: FILE_1_ID, path: 'a.md' }),
      file({ id: FILE_2_ID, path: 'b.md' }),
    ]);
    const slot = store.getState().drive.get(SESSION_ID)!;
    expect(slot.initialized).toBe(true);
    expect(slot.scope).toBe(`ses:${SESSION_ID}`);
    expect(slot.files.size).toBe(2);
    expect(slot.files.get('a.md')?.id).toBe(FILE_1_ID);
  });

  it('driveApplyAdded inserts a new entry', () => {
    store.getState().driveHydrate(SESSION_ID, `ses:${SESSION_ID}`, []);
    store.getState().driveApplyAdded(SESSION_ID, file({ path: 'fresh.md', id: FILE_10_ID }));
    expect(store.getState().drive.get(SESSION_ID)!.files.get('fresh.md')?.id).toBe(FILE_10_ID);
  });

  it('driveApplyUpdated overwrites by path', () => {
    store.getState().driveHydrate(SESSION_ID, `ses:${SESSION_ID}`, [file({ path: 'a.md', sizeBytes: 32 })]);
    store.getState().driveApplyUpdated(SESSION_ID, file({ path: 'a.md', sizeBytes: 99 }));
    expect(store.getState().drive.get(SESSION_ID)!.files.get('a.md')?.sizeBytes).toBe(99);
  });

  it('driveApplyDeleted is a no-op for unknown paths', () => {
    store.getState().driveHydrate(SESSION_ID, `ses:${SESSION_ID}`, [file({ path: 'a.md' })]);
    const before = store.getState().drive.get(SESSION_ID)!.files;
    store.getState().driveApplyDeleted(SESSION_ID, 'ghost.md');
    expect(store.getState().drive.get(SESSION_ID)!.files).toBe(before);
  });

  it('driveApplyDeleted removes the entry when present', () => {
    store.getState().driveHydrate(SESSION_ID, `ses:${SESSION_ID}`, [file({ path: 'a.md' }), file({ path: 'b.md' })]);
    store.getState().driveApplyDeleted(SESSION_ID, 'a.md');
    const files = store.getState().drive.get(SESSION_ID)!.files;
    expect(files.has('a.md')).toBe(false);
    expect(files.has('b.md')).toBe(true);
  });

  it('driveSetError stores the message without touching files', () => {
    store.getState().driveHydrate(SESSION_ID, `ses:${SESSION_ID}`, [file({ path: 'a.md' })]);
    store.getState().driveSetError(SESSION_ID, 'boom');
    const slot = store.getState().drive.get(SESSION_ID)!;
    expect(slot.error).toBe('boom');
    expect(slot.files.size).toBe(1);
  });

  it('driveReset drops the slot', () => {
    store.getState().driveHydrate(SESSION_ID, `ses:${SESSION_ID}`, [file()]);
    store.getState().driveReset(SESSION_ID);
    expect(store.getState().drive.has(SESSION_ID)).toBe(false);
  });
});
