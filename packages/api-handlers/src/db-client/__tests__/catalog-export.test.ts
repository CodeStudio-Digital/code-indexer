import { describe, expect, it } from 'vitest';
import { createSqliteDriver } from '@mcp/db-drivers';
import { readCatalogPage } from '../catalog.js';
import { exportTableRows } from '../export.js';
import { applyCheckedRowEdits } from '../checked-row-edits.js';

describe('bounded database journeys on real SQLite', () => {
  it('pages names without introspecting every table and binds its cursor to scope/revision', async () => {
    const driver = createSqliteDriver({ engine: 'sqlite', filePath: ':memory:' });
    try {
      await driver.runQuery(Array.from({ length: 205 }, (_, i) => `CREATE TABLE table_${String(i).padStart(3, '0')}(id INTEGER PRIMARY KEY)`).join(';'));
      const first = await readCatalogPage(driver, 'sqlite', 'project-1/connection-1:r1', { limit: 100 });
      expect(first.objects).toHaveLength(100); expect(first.complete).toBe(false);
      const second = await readCatalogPage(driver, 'sqlite', 'project-1/connection-1:r1', { cursor: first.nextCursor, limit: 100 });
      const last = await readCatalogPage(driver, 'sqlite', 'project-1/connection-1:r1', { cursor: second.nextCursor, limit: 100 });
      expect(last.complete).toBe(true); expect(last.objects).toHaveLength(5);
      expect(new Set([...first.objects, ...second.objects, ...last.objects].map(o => o.name)).size).toBe(205);
      await expect(readCatalogPage(driver, 'sqlite', 'project-1/connection-1:r2', { cursor: first.nextCursor })).rejects.toThrow(/scope changed/);
      const filtered = await readCatalogPage(driver, 'sqlite', 'project-1/connection-1:r1', { query: '_001' });
      expect(filtered.objects.map(o => o.name)).toEqual(['table_001']);
    } finally { await driver.close(); }
  });

  it('exports all components of a composite key without OFFSET and declares concurrent-write consistency', async () => {
    const driver = createSqliteDriver({ engine: 'sqlite', filePath: ':memory:' });
    try {
      await driver.runQuery('CREATE TABLE items(tenant TEXT NOT NULL, id INTEGER NOT NULL, note TEXT, PRIMARY KEY(tenant,id))');
      await driver.runQuery("INSERT INTO items VALUES('a',1,NULL),('a',2,'x'),('b',1,'y'),('b',2,'z')");
      const batches = [];
      for await (const batch of exportTableRows(driver, 'sqlite', 'main', 'items', 2)) batches.push(batch);
      expect(batches.flatMap(b => b.rows)).toHaveLength(4);
      expect(batches[0]).toMatchObject({ consistency: 'best_effort', pagination: 'keyset', done: false });
      expect(batches.at(-1)?.done).toBe(true);
      await applyCheckedRowEdits(driver, 'sqlite', [{ op: 'update', table: 'items', pk: { tenant: 'a', id: 1 }, original: { note: null }, values: { note: 'new' } }]);
      await expect(applyCheckedRowEdits(driver, 'sqlite', [{ op: 'delete', table: 'items', pk: { tenant: 'a', id: 1 }, original: { note: null } }])).rejects.toMatchObject({ code: 'db_edit_conflict' });
      expect((await driver.runQuery("SELECT note FROM items WHERE tenant='a' AND id=1")).rows).toEqual([{ note: 'new' }]);
    } finally { await driver.close(); }
  });
});
