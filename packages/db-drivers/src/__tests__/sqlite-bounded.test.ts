import { expect, it } from 'vitest';
import { createSqliteDriver } from '../sqlite.js';

it('stops a recursive SELECT at the requested window instead of evaluating the remaining rows', async () => {
  const driver = createSqliteDriver({ engine: 'sqlite', filePath: ':memory:' });
  try {
    // The third row throws if stepped. A row cap of one needs only rows 1 and 2.
    const result = await driver.runQuery(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      SELECT CASE WHEN x>2 THEN abs(-9223372036854775808) ELSE x END AS value FROM n`, { maxRows: 1 });
    expect(result).toMatchObject({ rows: [{ value: 1 }], rowCount: 2, truncated: true });
    // Early iterator closure must release the statement/connection lock.
    await driver.runQuery('CREATE TABLE next (id INTEGER)');
  } finally { await driver.close(); }
});

it('fully executes a mutation with RETURNING while retaining only bounded output', async () => {
  const driver = createSqliteDriver({ engine: 'sqlite', filePath: ':memory:' });
  try {
    await driver.runQuery('CREATE TABLE items (id INTEGER)');
    const inserted = await driver.runQuery('INSERT INTO items VALUES (1),(2),(3),(4) RETURNING id', { maxRows: 1 });
    expect(inserted).toMatchObject({ rows: [{ id: 1 }], rowCount: 4, truncated: true });
    expect((await driver.runQuery('SELECT count(*) AS count FROM items')).rows).toEqual([{ count: 4 }]);
  } finally { await driver.close(); }
});

it('does not start a cancelled mutation and rolls back a batch cancelled by its observer', async () => {
  const driver = createSqliteDriver({ engine: 'sqlite', filePath: ':memory:' });
  try {
    await driver.runQuery('CREATE TABLE items (id INTEGER)');
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(driver.runQuery('INSERT INTO items VALUES (1)', { signal: controller.signal })).rejects.toThrow('cancelled');
    const batch = new AbortController();
    await expect(driver.runBatch!(['INSERT INTO items VALUES (2)', 'INSERT INTO items VALUES (3)'], {
      signal: batch.signal, onResult: () => batch.abort(new Error('cancelled')),
    })).rejects.toThrow('cancelled');
    expect((await driver.runQuery('SELECT count(*) AS count FROM items')).rows).toEqual([{ count: 0 }]);
  } finally { await driver.close(); }
});
