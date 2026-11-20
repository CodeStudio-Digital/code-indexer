/**
 * Empirical coverage for the embedded sqlite-vec vector store. Runs real
 * sqlite-vec (vec0) under Node — verifies the version-specific KNN + metadata
 * filter SQL actually behaves, not just that it type-checks.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVecDatabase, SqliteVecVectorStore } from '../sqlite-vec-store.js';
import type { VectorRecord } from '@mcp/shared/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rec(id: string, values: number[], meta: Record<string, string>): VectorRecord {
  return { id, values, metadata: meta };
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-sqlite-vec-'));
  dirs.push(dir);
  return dir;
}

describe('SqliteVecVectorStore', () => {
  it('applies symbol families before KNN truncates a file-heavy neighborhood', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    try {
      const files = Array.from({ length: 12 }, (_, i) => rec('f' + i, [1, 0], { type: 'file' }));
      await store.upsert([...files, rec('body', [0.8, 0.2], { type: 'symbol_body' }),
        rec('group', [0.7, 0.3], { type: 'symbol_group' })], 'code:p7');
      const hits = await store.search([1, 0], { namespace: 'code:p7', topK: 2, types: ['symbol', 'symbol_body', 'symbol_group'] });
      expect(hits.map(hit => hit.id)).toEqual(['body', 'group']);
    } finally { store.close(); }
  });
  it('retries loading after a repaired native extension instead of caching rejection forever', async () => {
    const database = new SqliteVecDatabase(':memory:');
    try {
      const load = vi.spyOn(database.db, 'loadExtension');
      load.mockImplementationOnce(() => { throw new Error('Não foi possível encontrar o módulo especificado.'); });
      await expect(database.loadExtension()).rejects.toThrow('native extension unavailable');
      await expect(database.loadExtension()).resolves.toBeUndefined();
      expect(database.db.prepare('SELECT vec_version() version').get()).toHaveProperty('version');
      expect(load).toHaveBeenCalledTimes(2);
    } finally { database.close(); }
  });
  it('retries a busy legacy cleanup without discarding the original table on failure', async () => {
    const database = new SqliteVecDatabase(':memory:');
    try {
      await database.loadExtension();
      database.db.exec('CREATE TABLE vectors(id TEXT)');
      const original = database.db.exec.bind(database.db);
      const exec = vi.spyOn(database.db, 'exec').mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); });
      await expect(database.discardLegacyDefaultTable()).rejects.toThrow('SQLITE_BUSY');
      expect(database.db.prepare("SELECT name FROM sqlite_master WHERE name='vectors'").get()).toBeTruthy();
      exec.mockImplementation(original);
      await database.discardLegacyDefaultTable();
      expect(database.db.prepare("SELECT name FROM sqlite_master WHERE name='vectors'").get()).toBeUndefined();
    } finally { database.close(); }
  });
  it('drops only retired Knowledge generation tables during explicit cleanup', async () => {
    const database = new SqliteVecDatabase(join(freshDir(), 'vectors.db'));
    try {
      for (const tableName of ['knowledge_g_1', 'knowledge_g_2', 'memory_g_1', 'knowledgeXg_3']) {
        const store = new SqliteVecVectorStore({ database, tableName });
        await store.upsert([
          rec(tableName, [1, 0], { type: 'memory' }),
        ], 'memory:user');
      }

      expect(database.dropVirtualTablesWithPrefix('knowledge_g_')).toBe(2);
      const tables = database.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((row) => row.name);
      expect(names).not.toContain('knowledge_g_1');
      expect(names).not.toContain('knowledge_g_2');
      expect(names).toContain('memory_g_1');
      expect(names).toContain('knowledgeXg_3');
    } finally {
      database.close();
    }
  });

  it('discards the pre-generation default table when a generation table opens', async () => {
    const path = join(freshDir(), 'vectors.db');
    const legacy = new SqliteVecVectorStore({ path });
    await legacy.upsert([{
      id: 'legacy', values: [1, 0], metadata: { type: 'file', ref_id: '1' },
    }], 'code:p1');
    legacy.close();

    const generation = new SqliteVecVectorStore({ path, tableName: 'code_g_12' });
    try {
      await generation.upsert([{
        id: 'fresh', values: [0, 1], metadata: { type: 'file', ref_id: '2' },
      }], 'code:p1');
    } finally {
      generation.close();
    }
    const inspect = new SqliteVecDatabase(path);
    try {
      const tables = inspect.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).not.toContain('vectors');
      expect(tables.map((row) => row.name)).toContain('code_g_12');
    } finally {
      inspect.close();
    }
  });
  it('upserts, KNN-searches with a metadata filter, overwrites, and deletes', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    await store.upsert([
      rec('a', [1, 0, 0], { project_name: 'p', type: 'symbol_body', ref_id: '1' }),
      rec('b', [0, 1, 0], { project_name: 'p', type: 'snapshot', ref_id: '2' }),
      rec('c', [0.95, 0.05, 0], { project_name: 'q', type: 'symbol_body', ref_id: '3' }),
    ]);

    // Nearest to [1,0,0] restricted to project p + symbol_body → only 'a'
    // ('c' is closer in vector space but lives in project q).
    const filtered = await store.search([1, 0, 0], {
      topK: 5,
      filter: { project_name: 'p', type: 'symbol_body' },
    });
    expect(filtered.map((r) => r.id)).toEqual(['a']);
    expect(filtered[0].metadata.ref_id).toBe('1');
    expect(filtered[0].score).toBeGreaterThan(0);

    // No filter → 'a' nearest, 'c' also near.
    const all = await store.search([1, 0, 0], { topK: 3 });
    expect(all[0].id).toBe('a');
    expect(all.map((r) => r.id)).toContain('c');

    // Re-upsert 'a' with a new vector → overwrite, not duplicate.
    await store.upsert([rec('a', [0, 0, 1], { project_name: 'p', type: 'symbol_body', ref_id: '1' })]);
    const moved = await store.search([0, 0, 1], { topK: 1, filter: { project_name: 'p' } });
    expect(moved[0].id).toBe('a');

    await store.deleteByIds(['a']);
    const afterDelete = await store.search([0, 0, 1], { topK: 5, filter: { project_name: 'p' } });
    expect(afterDelete.map((r) => r.id)).not.toContain('a');
  });

  it('is available and returns [] before anything is indexed', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    expect(await store.isAvailable()).toBe(true);
    expect(await store.search([1, 2, 3], { topK: 5 })).toEqual([]);
  });

  it('isolates by namespace: a query in one namespace never sees another', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    // Same vector space, different namespaces (project A vs project B vs docs).
    await store.upsert([rec('a', [1, 0, 0], { project_name: 'A', type: 'symbol_body', ref_id: '1' })], 'code:A');
    await store.upsert([rec('b', [1, 0, 0], { project_name: 'B', type: 'symbol_body', ref_id: '2' })], 'code:B');
    await store.upsert([rec('d', [1, 0, 0], { type: 'doc_chunk', ref_id: '3' } as Record<string, string>)], 'docs:c5');

    const inA = await store.search([1, 0, 0], { topK: 10, namespace: 'code:A' });
    expect(inA.map((r) => r.id)).toEqual(['a']);

    const inDocs = await store.search([1, 0, 0], { topK: 10, namespace: 'docs:c5' });
    expect(inDocs.map((r) => r.id)).toEqual(['d']);
    // 'd' was upserted WITHOUT project_name → stored as '' (vec0 0.1.9 rejects
    // NULL in TEXT metadata) and OMITTED on read-back (truthy check), so the
    // returned shape matches the pre-0.1.9 NULL-omit behavior: type+ref_id
    // present, project_name absent.
    expect(inDocs[0].metadata).toEqual({ type: 'doc_chunk', ref_id: '3' });
    expect('project_name' in inDocs[0].metadata).toBe(false);

    // No namespace → sees everything (legacy/aggregate behavior).
    const all = await store.search([1, 0, 0], { topK: 10 });
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b', 'd']);
  });

  it('deleteNamespace drops only the target namespace', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:' });
    await store.upsert([rec('a', [1, 0, 0], { project_name: 'A', type: 'file', ref_id: '1' })], 'code:A');
    await store.upsert([rec('b', [0, 1, 0], { project_name: 'B', type: 'file', ref_id: '2' })], 'code:B');

    const removed = await store.deleteNamespace('code:A');
    expect(removed).toBe(1);

    expect((await store.search([1, 0, 0], { topK: 10, namespace: 'code:A' })).length).toBe(0);
    expect((await store.search([0, 1, 0], { topK: 10, namespace: 'code:B' })).map((r) => r.id)).toEqual(['b']);
  });

  it('supports safe generation tables with independent dimensions', async () => {
    const three = new SqliteVecVectorStore({ path: ':memory:', tableName: 'code_g_1' });
    await three.upsert([rec('a', [1, 0, 0], { type: 'file' })], 'code:p1');
    expect((await three.search([1, 0, 0], { namespace: 'code:p1' }))[0].id).toBe('a');
    three.close();

    expect(() => new SqliteVecVectorStore({ path: ':memory:', tableName: 'vectors; DROP TABLE vectors' }))
      .toThrow(/Unsafe sqlite-vec table name/);
  });

  it('normalizes stored and query vectors and rejects invalid embeddings', async () => {
    const store = new SqliteVecVectorStore({ path: ':memory:', tableName: 'code_g_2' });
    await store.upsert([
      rec('scaled', [100, 0], { type: 'file' }),
      rec('other', [0, 1], { type: 'file' }),
    ], 'code:p1');
    expect((await store.search([5, 0], { namespace: 'code:p1' }))[0].id).toBe('scaled');
    await expect(store.upsert([rec('zero', [0, 0], { type: 'file' })], 'code:p1'))
      .rejects.toThrow(/non-zero norm/);
    store.close();
  });

  it('configures WAL, NORMAL sync, busy timeout and truncates WAL on close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-sqlite-vec-pragmas-'));
    dirs.push(dir);
    const path = join(dir, 'vectors.db');
    const database = new SqliteVecDatabase(path, { manualCheckpoint: true });
    expect(database.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.db.pragma('synchronous', { simple: true })).toBe(1);
    expect(Number(database.db.pragma('busy_timeout', { simple: true }))).toBeGreaterThan(0);
    expect(database.db.pragma('wal_autocheckpoint', { simple: true })).toBe(0);
    const store = new SqliteVecVectorStore({ database, tableName: 'code_g_1' });
    await store.upsert([rec('a', [1, 0], { type: 'file' })], 'code:p1');
    database.close();
    expect(!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0)
      .toBe(true);
  });
});
