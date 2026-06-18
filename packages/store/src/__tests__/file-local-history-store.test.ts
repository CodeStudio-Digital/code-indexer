/**
 * FileLocalHistoryStore — content-addressed dedup, refcount GC, prune.
 * Roda com `pnpm node:rebuild` (better-sqlite3 ABI) com o app fechado.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { fileLocalHistory160 } from '../migrations/160_file_local_history.js';
import { FileLocalHistoryStore } from '../file-local-history-store.js';

type DB = InstanceType<typeof Database>;

let db: DB;
let store: FileLocalHistoryStore;

const blobCount = (): number => (db.prepare('SELECT COUNT(*) c FROM file_history_blobs').get() as { c: number }).c;

beforeEach(() => {
  db = new Database(':memory:');
  fileLocalHistory160.up(db);
  store = new FileLocalHistoryStore(db);
});

describe('recordRevision', () => {
  it('lists newest-first', () => {
    store.recordRevision({ projectId: 1, path: 'a.ts', content: 'v0', kind: 'save' });
    store.recordRevision({ projectId: 1, path: 'a.ts', content: 'v1', kind: 'save' });
    const list = store.listRevisions(1, 'a.ts');
    expect(list.map((r) => r.id)).toEqual([2, 1]);
  });

  it('dedups identical consecutive content (returns null)', () => {
    store.recordRevision({ projectId: 1, path: 'a.ts', content: 'same', kind: 'save' });
    const dup = store.recordRevision({ projectId: 1, path: 'a.ts', content: 'same', kind: 'save' });
    expect(dup).toBeNull();
    expect(store.listRevisions(1, 'a.ts')).toHaveLength(1);
  });

  it('tombstone: content null → existed_before 0, no blob', () => {
    const rev = store.recordRevision({ projectId: 1, path: 'new.ts', content: null, kind: 'save' });
    expect(rev?.existed_before).toBe(0);
    expect(rev?.content_hash).toBeNull();
    expect(blobCount()).toBe(0);
  });

  it('oversized: existed_before 1, no blob, keeps real size', () => {
    const rev = store.recordRevision({ projectId: 1, path: 'big.bin', content: null, kind: 'save', oversized: true, size: 9999 });
    expect(rev?.existed_before).toBe(1);
    expect(rev?.content_hash).toBeNull();
    expect(rev?.oversized).toBe(1);
    expect(rev?.size).toBe(9999);
  });

  it('shared content reuses one refcounted blob', () => {
    store.recordRevision({ projectId: 1, path: 'a.ts', content: 'X', kind: 'save' });
    store.recordRevision({ projectId: 1, path: 'b.ts', content: 'X', kind: 'save' });
    expect(blobCount()).toBe(1);
    const refcount = (db.prepare('SELECT refcount FROM file_history_blobs').get() as { refcount: number }).refcount;
    expect(refcount).toBe(2);
  });
});

describe('getRevisionContent', () => {
  it('returns the stored content; null for tombstone', () => {
    const a = store.recordRevision({ projectId: 1, path: 'a.ts', content: 'hello', kind: 'save' })!;
    expect(store.getRevisionContent(a.id)).toBe('hello');
    const t = store.recordRevision({ projectId: 1, path: 'b.ts', content: null, kind: 'save' })!;
    expect(store.getRevisionContent(t.id)).toBeNull();
  });
});

describe('prune', () => {
  it('pruneForFile keeps newest N, deletes older (oldest-first)', () => {
    for (let i = 0; i < 5; i++) store.recordRevision({ projectId: 1, path: 'a.ts', content: `v${i}`, kind: 'save' });
    const removed = store.pruneForFile(1, 'a.ts', { maxPerFile: 2, maxAgeDays: 9999 });
    expect(removed).toBe(3);
    const list = store.listRevisions(1, 'a.ts');
    expect(list).toHaveLength(2);
    // Newest survive (highest ids).
    expect(list.map((r) => r.id)).toEqual([5, 4]);
  });

  it('pruneForFile exempts labeled revisions from the cap', () => {
    const first = store.recordRevision({ projectId: 1, path: 'a.ts', content: 'v0', kind: 'save' })!;
    store.recordRevision({ projectId: 1, path: 'a.ts', content: 'v1', kind: 'save' });
    store.recordRevision({ projectId: 1, path: 'a.ts', content: 'v2', kind: 'save' });
    store.labelRevision(first.id, 'keep me');
    store.pruneForFile(1, 'a.ts', { maxPerFile: 1, maxAgeDays: 9999 });
    const ids = store.listRevisions(1, 'a.ts').map((r) => r.id);
    expect(ids).toContain(first.id); // labeled survives
    expect(ids).toHaveLength(2); // labeled + newest unlabeled
  });

  it('pruneForProject clears rows and orphan blobs', () => {
    store.recordRevision({ projectId: 1, path: 'a.ts', content: 'X', kind: 'save' });
    store.recordRevision({ projectId: 1, path: 'b.ts', content: 'Y', kind: 'save' });
    store.pruneForProject(1);
    expect(store.listRevisions(1, 'a.ts')).toHaveLength(0);
    expect(blobCount()).toBe(0);
  });

  it('pruneForProject keeps blobs still referenced by another project', () => {
    store.recordRevision({ projectId: 1, path: 'a.ts', content: 'shared', kind: 'save' });
    store.recordRevision({ projectId: 2, path: 'a.ts', content: 'shared', kind: 'save' });
    store.pruneForProject(1);
    expect(blobCount()).toBe(1); // project 2 still references it
    expect(store.listRevisions(2, 'a.ts')).toHaveLength(1);
  });
});
