/**
 * Personal-sync service tests with an in-memory repo + a deterministic hasher.
 * Covers: insert/version assignment, idempotent no-op re-push, clean update,
 * stale-base CONFLICT resolved by LWW (both directions) with the loser archived,
 * tombstone delete, and pull(sinceVersion) feed semantics. No D1, no WebCrypto.
 */
import { describe, it, expect } from 'vitest';
import { SyncService, decidePush, stableStringify } from '../sync/service.js';
import { refKey, type SyncKind, type SyncLoser, type SyncRepo, type SyncRow, type SyncWrite } from '../sync/types.js';

// Hash = the canonical body itself (collision-free for our test bodies).
const hash = async (s: string) => `h:${s}`;

class FakeSyncRepo implements SyncRepo {
  heads = new Map<string, SyncRow>();
  archive: { reason: string; row: SyncLoser }[] = [];
  async currentMaxVersion() {
    let m = 0;
    for (const r of this.heads.values()) m = Math.max(m, r.version);
    return m;
  }
  async loadAll() {
    return new Map(this.heads);
  }
  async apply(writes: SyncWrite[], losers: SyncLoser[]) {
    for (const w of writes) {
      if (w.archivePrev) this.archive.push({ reason: w.archivePrev.reason, row: { kind: w.row.kind, clientDocId: w.row.clientDocId, version: w.archivePrev.version, bodyJson: w.archivePrev.bodyJson, bodySha256: w.archivePrev.bodySha256 } });
      this.heads.set(refKey(w.row.kind, w.row.clientDocId), { ...w.row });
    }
    for (const l of losers) this.archive.push({ reason: 'conflict_loser', row: l });
  }
  async listSince(kinds: readonly SyncKind[], sinceVersion: number, limit: number) {
    return [...this.heads.values()]
      .filter((r) => r.version > sinceVersion && kinds.includes(r.kind))
      .sort((a, b) => a.version - b.version)
      .slice(0, limit);
  }
}

const item = (over: Partial<{ kind: SyncKind; clientDocId: string; baseVersion: number; updatedAtMs: number; deleted: boolean; body: unknown }> = {}) => ({
  kind: 'collection' as SyncKind,
  clientDocId: 'doc1',
  baseVersion: 0,
  updatedAtMs: 1000,
  body: { name: 'Coll', requests: [] },
  ...over,
});

describe('decidePush (pure LWW policy)', () => {
  const head: SyncRow = { kind: 'collection', clientDocId: 'd', version: 5, bodyJson: '{}', bodySha256: 'X', deleted: false, updatedAtMs: 100 };
  it('no head → insert', () => expect(decidePush(null, 'A', 0, 1)).toBe('insert'));
  it('same content → noop', () => expect(decidePush(head, 'X', 5, 999)).toBe('noop'));
  it('base matches head → apply', () => expect(decidePush(head, 'Y', 5, 50)).toBe('apply'));
  it('stale base, newer edit → incoming_wins', () => expect(decidePush(head, 'Y', 2, 200)).toBe('incoming_wins'));
  it('stale base, older edit → existing_wins', () => expect(decidePush(head, 'Y', 2, 50)).toBe('existing_wins'));
});

describe('stableStringify', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});

describe('SyncService.push', () => {
  it('inserts a new doc at version 1 and is idempotent on re-push', async () => {
    const repo = new FakeSyncRepo();
    const svc = new SyncService(repo, hash);
    const r1 = await svc.push([item()]);
    expect(r1.results[0].status).toBe('applied');
    expect(r1.results[0].version).toBe(1);
    expect(r1.cursor).toBe(1);
    // Re-push same content with the new baseVersion → noop, no version bump.
    const r2 = await svc.push([item({ baseVersion: 1 })]);
    expect(r2.results[0].status).toBe('noop');
    expect(r2.results[0].version).toBe(1);
  });

  it('clean update when baseVersion matches the head', async () => {
    const repo = new FakeSyncRepo();
    const svc = new SyncService(repo, hash);
    await svc.push([item()]);
    const r = await svc.push([item({ baseVersion: 1, updatedAtMs: 2000, body: { name: 'Renamed', requests: [] } })]);
    expect(r.results[0].status).toBe('applied');
    expect(r.results[0].version).toBe(2);
    expect(repo.archive.find((a) => a.reason === 'superseded')).toBeTruthy();
  });

  it('stale push: newer edit wins, loser preserved', async () => {
    const repo = new FakeSyncRepo();
    const svc = new SyncService(repo, hash);
    await svc.push([item()]); // head v1, updatedAt 1000
    const r = await svc.push([item({ baseVersion: 0, updatedAtMs: 5000, body: { name: 'Newer', requests: [] } })]);
    expect(r.results[0].status).toBe('conflict');
    expect(r.results[0].winner).toBe('incoming');
    expect(repo.heads.get(refKey('collection', 'doc1'))!.updatedAtMs).toBe(5000);
    expect(repo.archive.find((a) => a.reason === 'conflict_superseded')).toBeTruthy();
  });

  it('stale push: older edit loses, head untouched, loser archived', async () => {
    const repo = new FakeSyncRepo();
    const svc = new SyncService(repo, hash);
    await svc.push([item({ updatedAtMs: 9000 })]); // head v1, updatedAt 9000
    const r = await svc.push([item({ baseVersion: 0, updatedAtMs: 1, body: { name: 'Older', requests: [] } })]);
    expect(r.results[0].status).toBe('conflict');
    expect(r.results[0].winner).toBe('existing');
    expect(repo.heads.get(refKey('collection', 'doc1'))!.updatedAtMs).toBe(9000);
    expect(repo.archive.find((a) => a.reason === 'conflict_loser')).toBeTruthy();
  });

  it('delete writes a tombstone', async () => {
    const repo = new FakeSyncRepo();
    const svc = new SyncService(repo, hash);
    await svc.push([item()]);
    const r = await svc.push([item({ baseVersion: 1, deleted: true, body: undefined, updatedAtMs: 3000 })]);
    expect(r.results[0].status).toBe('applied');
    const head = repo.heads.get(refKey('collection', 'doc1'))!;
    expect(head.deleted).toBe(true);
    expect(head.bodyJson).toBeNull();
  });
});

describe('SyncService.pull', () => {
  it('returns docs past the cursor and advances it', async () => {
    const repo = new FakeSyncRepo();
    const svc = new SyncService(repo, hash);
    await svc.push([item({ clientDocId: 'a' })]); // v1
    await svc.push([item({ clientDocId: 'b' })]); // v2
    const all = await svc.pull(['collection'], 0);
    expect(all.documents.map((d) => d.clientDocId)).toEqual(['a', 'b']);
    expect(all.cursor).toBe(2);
    const tail = await svc.pull(['collection'], 1);
    expect(tail.documents.map((d) => d.clientDocId)).toEqual(['b']);
    expect(tail.cursor).toBe(2);
    // A pull with no changes keeps the cursor.
    const none = await svc.pull(['collection'], 2);
    expect(none.documents).toEqual([]);
    expect(none.cursor).toBe(2);
  });

  it('filters by kind and round-trips the body', async () => {
    const repo = new FakeSyncRepo();
    const svc = new SyncService(repo, hash);
    await svc.push([item({ kind: 'environment', clientDocId: 'e', body: { base_url: 'x' } })]);
    await svc.push([item({ kind: 'collection', clientDocId: 'c' })]);
    const envs = await svc.pull(['environment'], 0);
    expect(envs.documents).toHaveLength(1);
    expect(envs.documents[0].body).toEqual({ base_url: 'x' });
  });
});
