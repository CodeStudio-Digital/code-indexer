import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createDriveSlice,
  type DriveFileMeta,
  type DriveSlice,
} from '@apps/dashboard/state/company/driveSlice.js';

type Store = UseBoundStore<StoreApi<DriveSlice>>;

function file(overrides: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return {
    id: 1,
    scopeKey: 'ses:42',
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
    store.getState().driveEnsure(42);
    expect(store.getState().drive.get(42)?.initialized).toBe(false);
  });

  it('hydrate replaces the file map and sets initialized + scope', () => {
    store.getState().driveHydrate(42, 'ses:42', [
      file({ id: 1, path: 'a.md' }),
      file({ id: 2, path: 'b.md' }),
    ]);
    const slot = store.getState().drive.get(42)!;
    expect(slot.initialized).toBe(true);
    expect(slot.scope).toBe('ses:42');
    expect(slot.files.size).toBe(2);
    expect(slot.files.get('a.md')?.id).toBe(1);
  });

  it('driveApplyAdded inserts a new entry', () => {
    store.getState().driveHydrate(42, 'ses:42', []);
    store.getState().driveApplyAdded(42, file({ path: 'fresh.md', id: 10 }));
    expect(store.getState().drive.get(42)!.files.get('fresh.md')?.id).toBe(10);
  });

  it('driveApplyUpdated overwrites by path', () => {
    store.getState().driveHydrate(42, 'ses:42', [file({ path: 'a.md', sizeBytes: 32 })]);
    store.getState().driveApplyUpdated(42, file({ path: 'a.md', sizeBytes: 99 }));
    expect(store.getState().drive.get(42)!.files.get('a.md')?.sizeBytes).toBe(99);
  });

  it('driveApplyDeleted is a no-op for unknown paths', () => {
    store.getState().driveHydrate(42, 'ses:42', [file({ path: 'a.md' })]);
    const before = store.getState().drive.get(42)!.files;
    store.getState().driveApplyDeleted(42, 'ghost.md');
    expect(store.getState().drive.get(42)!.files).toBe(before);
  });

  it('driveApplyDeleted removes the entry when present', () => {
    store.getState().driveHydrate(42, 'ses:42', [file({ path: 'a.md' }), file({ path: 'b.md' })]);
    store.getState().driveApplyDeleted(42, 'a.md');
    const files = store.getState().drive.get(42)!.files;
    expect(files.has('a.md')).toBe(false);
    expect(files.has('b.md')).toBe(true);
  });

  it('driveSetError stores the message without touching files', () => {
    store.getState().driveHydrate(42, 'ses:42', [file({ path: 'a.md' })]);
    store.getState().driveSetError(42, 'boom');
    const slot = store.getState().drive.get(42)!;
    expect(slot.error).toBe('boom');
    expect(slot.files.size).toBe(1);
  });

  it('driveReset drops the slot', () => {
    store.getState().driveHydrate(42, 'ses:42', [file()]);
    store.getState().driveReset(42);
    expect(store.getState().drive.has(42)).toBe(false);
  });
});
