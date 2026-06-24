import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDriver } from '../factory.js';
import { buildDml } from '../sql/dml.js';
import { buildDdl } from '../ddl/build.js';
import type { DatabaseDriver, DbConnectConfig, DbEngine } from '../types.js';

/**
 * REAL-database integration tests — they validate introspection, DML and DDL
 * against an actual Postgres/MySQL, which unit tests (pure builders) and the
 * sqlite smoke can't. Zero extra deps: point them at a running DB via env URLs.
 * Without the env var the suite is SKIPPED, so CI/local without Docker stays green.
 *
 *   docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
 *   DB_IT_PG_URL=postgres://postgres:pw@localhost:5432/postgres pnpm vitest integration
 *
 *   docker run --rm -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=test -p 3306:3306 mysql:8
 *   DB_IT_MYSQL_URL=mysql://root:pw@localhost:3306/test pnpm vitest integration
 */

const PG_URL = process.env.DB_IT_PG_URL;
const MYSQL_URL = process.env.DB_IT_MYSQL_URL;

function suite(engine: DbEngine, url: string | undefined, schema: string) {
  describe.skipIf(!url)(`${engine} integration`, () => {
    let driver: DatabaseDriver;
    const table = 'it_dbclient_test';
    const child = 'it_dbclient_child';

    beforeAll(async () => {
      driver = await createDriver({ engine, connectionString: url } as DbConnectConfig);
      // Clean slate.
      await driver.runQuery(`DROP TABLE IF EXISTS ${child}`).catch(() => void 0);
      await driver.runQuery(`DROP TABLE IF EXISTS ${table}`).catch(() => void 0);
      await driver.runQuery(buildDdl(engine, 'create', {
        create: {
          schema,
          table,
          columns: [
            { name: 'id', type: engine === 'postgres' ? 'bigint' : 'INT', primaryKey: true, autoIncrement: true, nullable: false },
            { name: 'name', type: engine === 'postgres' ? 'text' : 'VARCHAR(120)', nullable: false },
            { name: 'email', type: engine === 'postgres' ? 'text' : 'VARCHAR(160)' },
          ],
        },
      })[0]);
    });

    afterAll(async () => {
      if (!driver) return;
      await driver.runQuery(`DROP TABLE IF EXISTS ${child}`).catch(() => void 0);
      await driver.runQuery(`DROP TABLE IF EXISTS ${table}`).catch(() => void 0);
      await driver.close();
    });

    it('testConnection returns a server version', async () => {
      const { serverVersion } = await driver.testConnection();
      expect(typeof serverVersion).toBe('string');
      expect(serverVersion!.length).toBeGreaterThan(0);
    });

    it('introspects the created table (columns + pk)', async () => {
      const tables = await driver.listTables(schema);
      expect(tables.map((t) => t.name)).toContain(table);
      const info = await driver.describeTable(schema, table);
      const id = info.columns.find((c) => c.name === 'id')!;
      const name = info.columns.find((c) => c.name === 'name')!;
      expect(id.isPrimaryKey).toBe(true);
      expect(name.nullable).toBe(false);
    });

    it('INSERT/UPDATE/DELETE via buildDml round-trips', async () => {
      const ins = buildDml(engine, { op: 'insert', schema, table, values: { name: 'Ada', email: 'ada@x.io' } });
      await driver.runQuery(ins.sql, { params: ins.params });
      let rows = await driver.runQuery(`SELECT * FROM ${table} ORDER BY id`);
      expect(rows.rowCount).toBe(1);
      const id = (rows.rows[0] as { id: number | string }).id;

      const upd = buildDml(engine, { op: 'update', schema, table, pk: { id }, values: { name: 'Linus' } });
      await driver.runQuery(upd.sql, { params: upd.params });
      rows = await driver.runQuery(`SELECT name FROM ${table} WHERE id = ${typeof id === 'number' ? id : `'${id}'`}`);
      expect(rows.rows[0].name).toBe('Linus');

      const del = buildDml(engine, { op: 'delete', schema, table, pk: { id } });
      await driver.runQuery(del.sql, { params: del.params });
      rows = await driver.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number((rows.rows[0] as { n: number | string }).n)).toBe(0);
    });

    it('ALTER add/drop column via buildDdl', async () => {
      for (const stmt of buildDdl(engine, 'alter', {
        alter: { schema, table, actions: [{ kind: 'addColumn', column: { name: 'note', type: engine === 'postgres' ? 'text' : 'VARCHAR(50)' } }] },
      })) {
        await driver.runQuery(stmt);
      }
      let info = await driver.describeTable(schema, table);
      expect(info.columns.map((c) => c.name)).toContain('note');

      for (const stmt of buildDdl(engine, 'alter', { alter: { schema, table, actions: [{ kind: 'dropColumn', name: 'note' }] } })) {
        await driver.runQuery(stmt);
      }
      info = await driver.describeTable(schema, table);
      expect(info.columns.map((c) => c.name)).not.toContain('note');
    });

    it('reports foreign keys', async () => {
      await driver.runQuery(buildDdl(engine, 'create', {
        create: {
          schema,
          table: child,
          columns: [
            { name: 'id', type: engine === 'postgres' ? 'bigint' : 'INT', primaryKey: true, autoIncrement: true, nullable: false },
            { name: 'parent_id', type: engine === 'postgres' ? 'bigint' : 'INT' },
          ],
        },
      })[0]);
      const fkName = 'it_fk_parent';
      const ref = engine === 'postgres' ? `"${schema}"."${table}"` : `\`${table}\``;
      const childRel = engine === 'postgres' ? `"${schema}"."${child}"` : `\`${child}\``;
      const col = engine === 'postgres' ? '"parent_id"' : '`parent_id`';
      await driver.runQuery(`ALTER TABLE ${childRel} ADD CONSTRAINT ${fkName} FOREIGN KEY (${col}) REFERENCES ${ref} (${engine === 'postgres' ? '"id"' : '`id`'})`);
      const info = await driver.describeTable(schema, child);
      expect(info.foreignKeys?.some((fk) => fk.refTable === table && fk.columns.includes('parent_id'))).toBe(true);
    });

    it('caps rows and cancels a long query', async () => {
      // Insert a few rows, cap to 1.
      for (let i = 0; i < 3; i++) {
        const ins = buildDml(engine, { op: 'insert', schema, table, values: { name: `r${i}` } });
        await driver.runQuery(ins.sql, { params: ins.params });
      }
      const capped = await driver.runQuery(`SELECT * FROM ${table}`, { maxRows: 1 });
      expect(capped.rows.length).toBe(1);
      expect(capped.truncated).toBe(true);

      // Cancel a sleeping query.
      const ctrl = new AbortController();
      const sleepSql = engine === 'postgres' ? 'SELECT pg_sleep(3)' : 'SELECT SLEEP(3)';
      const p = driver.runQuery(sleepSql, { signal: ctrl.signal });
      const timer = setTimeout(() => ctrl.abort(), 250);
      await expect(p).rejects.toThrow();
      clearTimeout(timer);
    });
  });
}

suite('postgres', PG_URL, 'public');
suite('mysql', MYSQL_URL, mysqlSchemaFromUrl(MYSQL_URL));

/** MySQL "schema" == database; pull it from the URL path (default 'test'). */
function mysqlSchemaFromUrl(url: string | undefined): string {
  if (!url) return 'test';
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    return path || 'test';
  } catch {
    return 'test';
  }
}
