import { expect, it } from 'vitest';
import { createSqliteProcessDriver } from '../sqlite-process.js';

it('cancels a queued request promptly without interrupting the active owner', async () => {
  const driver = await createSqliteProcessDriver({ engine: 'sqlite', filePath: ':memory:' });
  try {
    const active = driver.runQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n', { timeoutMs: 500 });
    const activeResult = expect(active).rejects.toMatchObject({ code: 'SQLITE_EXECUTOR_RETIRED' });
    const controller = new AbortController();
    const queued = driver.runQuery('SELECT 1', { signal: controller.signal });
    const start = Date.now(); controller.abort(new Error('queued cancelled'));
    await expect(queued).rejects.toThrow('queued cancelled');
    expect(Date.now() - start).toBeLessThan(200);
    await activeResult;
  } finally { await driver.close(); }
}, 15_000);

it('keeps the host responsive while cancelling native SQLite work and retires the connection', async () => {
  const driver = await createSqliteProcessDriver({ engine: 'sqlite', filePath: ':memory:' });
  let ticks = 0;
  const interval = setInterval(() => ticks++, 10);
  try {
    await expect(driver.runQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n', { timeoutMs: 150 }))
      .rejects.toMatchObject({ code: 'SQLITE_EXECUTOR_RETIRED' });
    expect(ticks).toBeGreaterThan(3);
    await expect(driver.runQuery('SELECT 1')).rejects.toThrow(/retired/);
  } finally { clearInterval(interval); await driver.close(); }
}, 15_000);

it('rolls back a checked edit conflict on the same child connection', async () => {
  const driver = await createSqliteProcessDriver({ engine: 'sqlite', filePath: ':memory:' });
  try {
    await driver.runQuery('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)');
    await driver.runQuery("INSERT INTO items VALUES(1,'original')");
    await expect(driver.runBatch!(["UPDATE items SET value='new' WHERE id=1", "UPDATE items SET value='bad' WHERE id=2"], {
      onResult: result => { if (result.rowCount !== 1) throw new Error('conflict'); },
    })).rejects.toMatchObject({ outcome: { effect: 'rolled_back' } });
    expect((await driver.runQuery('SELECT value FROM items')).rows).toEqual([{ value: 'original' }]);
  } finally { await driver.close(); }
});
