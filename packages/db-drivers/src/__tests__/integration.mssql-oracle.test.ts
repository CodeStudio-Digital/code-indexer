import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDriver } from '../factory.js';
import { buildDml } from '../sql/dml.js';
import { buildDdl } from '../ddl/build.js';
import type { DatabaseDriver, DbConnectConfig } from '../types.js';

/**
 * REAL-database integration tests for the SQL Server and Oracle drivers — they
 * validate introspection, DML and DDL against an actual server, which the pure
 * builder unit tests and the sqlite smoke can't. Zero extra deps: point them at
 * a running DB via env URLs. Without the env var each suite is SKIPPED, so
 * CI/local without those servers stays green.
 *
 *   docker run --rm -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Str0ng!Pass -p 1433:1433 \
 *     mcr.microsoft.com/mssql/server:2022-latest
 *   DB_IT_MSSQL_URL='Server=localhost,1433;Database=tempdb;User Id=sa;Password=Str0ng!Pass;Encrypt=false' \
 *     pnpm vitest integration.mssql-oracle
 *
 *   docker run --rm -e ORACLE_PASSWORD=pw -p 1521:1521 gvenzl/oracle-free
 *   DB_IT_ORACLE_URL='oracle://system:pw@localhost:1521/FREEPDB1' pnpm vitest integration.mssql-oracle
 *
 * NOTE: node-mssql only parses a connection string as a bare STRING (see mssql.ts),
 * so DB_IT_MSSQL_URL is an mssql config string, not a URL. The Oracle driver lazily
 * imports `oracledb` from its per-engine install dir; if it isn't installed the
 * beforeAll throws and the suite fails — only enable the env var once it's present.
 */

const MSSQL_URL = process.env.DB_IT_MSSQL_URL;
const ORACLE_URL = process.env.DB_IT_ORACLE_URL;

// ─── SQL Server ────────────────────────────────────────────────────────────
describe.skipIf(!MSSQL_URL)('mssql integration', () => {
  let driver: DatabaseDriver;
  const engine = 'mssql' as const;
  const schema = 'dbo';
  const table = 'it_dbclient_test';
  const child = 'it_dbclient_child';

  beforeAll(async () => {
    driver = await createDriver({ engine, connectionString: MSSQL_URL } as DbConnectConfig);
    // Clean slate (child first — FK could reference the parent).
    await driver.runQuery(`DROP TABLE IF EXISTS [${schema}].[${child}]`).catch(() => void 0);
    await driver.runQuery(`DROP TABLE IF EXISTS [${schema}].[${table}]`).catch(() => void 0);
    await driver.runQuery(
      buildDdl(engine, 'create', {
        create: {
          schema,
          table,
          columns: [
            { name: 'id', type: 'INT', primaryKey: true, autoIncrement: true, nullable: false },
            { name: 'name', type: 'NVARCHAR(120)', nullable: false },
            { name: 'email', type: 'NVARCHAR(160)' },
          ],
        },
      })[0],
    );
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.runQuery(`DROP TABLE IF EXISTS [${schema}].[${child}]`).catch(() => void 0);
    await driver.runQuery(`DROP TABLE IF EXISTS [${schema}].[${table}]`).catch(() => void 0);
    await driver.close();
  });

  it('testConnection returns a server version', async () => {
    const { serverVersion } = await driver.testConnection();
    expect(typeof serverVersion).toBe('string');
    expect(serverVersion!.length).toBeGreaterThan(0);
  });

  it('describeTable reports columns + primary key', async () => {
    const tables = await driver.listTables(schema);
    expect(tables.map((t) => t.name)).toContain(table);
    const info = await driver.describeTable(schema, table);
    expect(info.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'name', 'email']));
    const id = info.columns.find((c) => c.name === 'id')!;
    const name = info.columns.find((c) => c.name === 'name')!;
    expect(id.isPrimaryKey).toBe(true);
    expect(id.isAutoIncrement).toBe(true);
    expect(name.nullable).toBe(false);
  });

  it('INSERT/UPDATE/DELETE via buildDml round-trips', async () => {
    const ins1 = buildDml(engine, { op: 'insert', schema, table, values: { name: 'Ada', email: 'ada@x.io' } });
    await driver.runQuery(ins1.sql, { params: ins1.params });
    const ins2 = buildDml(engine, { op: 'insert', schema, table, values: { name: 'Grace', email: 'grace@x.io' } });
    await driver.runQuery(ins2.sql, { params: ins2.params });

    let rows = await driver.runQuery(`SELECT * FROM [${schema}].[${table}] ORDER BY [id]`);
    expect(rows.rowCount).toBe(2);
    const id = (rows.rows[0] as { id: number }).id;

    const upd = buildDml(engine, { op: 'update', schema, table, pk: { id }, values: { name: 'Linus' } });
    await driver.runQuery(upd.sql, { params: upd.params });
    rows = await driver.runQuery(`SELECT [name] FROM [${schema}].[${table}] WHERE [id] = ${id}`);
    expect(rows.rows[0].name).toBe('Linus');

    const del = buildDml(engine, { op: 'delete', schema, table, pk: { id } });
    await driver.runQuery(del.sql, { params: del.params });
    rows = await driver.runQuery(`SELECT COUNT(*) AS n FROM [${schema}].[${table}]`);
    expect(Number((rows.rows[0] as { n: number }).n)).toBe(1);
  });

  it('tablePreview honors WHERE + orderBy', async () => {
    const res = await driver.tablePreview(schema, table, {
      limit: 10,
      offset: 0,
      orderBy: { column: 'name', dir: 'asc' },
      where: [{ column: 'name', op: '=', value: 'Grace' }],
    });
    expect(res.rows.length).toBe(1);
    expect((res.rows[0] as { name: string }).name).toBe('Grace');
  });

  it('reports foreign keys', async () => {
    await driver.runQuery(
      buildDdl(engine, 'create', {
        create: {
          schema,
          table: child,
          columns: [
            { name: 'id', type: 'INT', primaryKey: true, autoIncrement: true, nullable: false },
            { name: 'parent_id', type: 'INT' },
          ],
        },
      })[0],
    );
    await driver.runQuery(
      `ALTER TABLE [${schema}].[${child}] ADD CONSTRAINT it_fk_parent FOREIGN KEY ([parent_id]) REFERENCES [${schema}].[${table}] ([id])`,
    );
    const info = await driver.describeTable(schema, child);
    expect(info.foreignKeys?.some((fk) => fk.refTable === table && fk.columns.includes('parent_id'))).toBe(true);
  });
});

// ─── Oracle ──────────────────────────────────────────────────────────────
// Oracle folds unquoted identifiers to UPPERCASE and the data dictionary stores
// them uppercase. We create with unquoted (lowercase) names, then introspect by
// the uppercase form the dictionary reports — owner is the connecting user.
describe.skipIf(!ORACLE_URL)('oracle integration', () => {
  let driver: DatabaseDriver;
  const engine = 'oracle' as const;
  const table = 'it_dbclient_test';
  const child = 'it_dbclient_child';
  // Resolved in beforeAll once we know the connecting user.
  let owner = '';
  const TABLE = table.toUpperCase();
  const CHILD = child.toUpperCase();

  beforeAll(async () => {
    driver = await createDriver({ engine, connectionString: ORACLE_URL } as DbConnectConfig);
    const u = await driver.runQuery('SELECT USER AS owner FROM dual');
    owner = String((u.rows[0] as { OWNER?: string; owner?: string }).OWNER ?? (u.rows[0] as { owner?: string }).owner ?? '').toUpperCase();
    // Oracle has no DROP TABLE IF EXISTS — swallow ORA-00942 (table doesn't exist).
    await driver.runQuery(`DROP TABLE ${child} CASCADE CONSTRAINTS`).catch(() => void 0);
    await driver.runQuery(`DROP TABLE ${table} CASCADE CONSTRAINTS`).catch(() => void 0);
    await driver.runQuery(
      buildDdl(engine, 'create', {
        create: {
          table,
          columns: [
            { name: 'id', type: 'NUMBER', primaryKey: true, autoIncrement: true, nullable: false },
            { name: 'name', type: 'VARCHAR2(120)', nullable: false },
            { name: 'email', type: 'VARCHAR2(160)' },
          ],
        },
      })[0],
    );
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.runQuery(`DROP TABLE ${child} CASCADE CONSTRAINTS`).catch(() => void 0);
    await driver.runQuery(`DROP TABLE ${table} CASCADE CONSTRAINTS`).catch(() => void 0);
    await driver.close();
  });

  it('testConnection returns a server version', async () => {
    const { serverVersion } = await driver.testConnection();
    expect(typeof serverVersion).toBe('string');
    expect(serverVersion!.length).toBeGreaterThan(0);
  });

  it('describeTable reports columns + primary key', async () => {
    const tables = await driver.listTables(owner);
    expect(tables.map((t) => t.name)).toContain(TABLE);
    const info = await driver.describeTable(owner, TABLE);
    expect(info.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['ID', 'NAME', 'EMAIL']));
    const id = info.columns.find((c) => c.name === 'ID')!;
    const name = info.columns.find((c) => c.name === 'NAME')!;
    expect(id.isPrimaryKey).toBe(true);
    expect(id.isAutoIncrement).toBe(true);
    expect(name.nullable).toBe(false);
  });

  it('INSERT/UPDATE/DELETE via buildDml round-trips', async () => {
    // buildDml quotes identifiers double-quoted (lowercase) for Oracle, so the
    // column names must match the unquoted-folded UPPERCASE form. Build the DML
    // against the uppercase column names so the quoted identifiers resolve.
    const ins1 = buildDml(engine, { op: 'insert', table, values: { ID: 1, NAME: 'Ada', EMAIL: 'ada@x.io' } });
    await driver.runQuery(ins1.sql, { params: ins1.params });
    const ins2 = buildDml(engine, { op: 'insert', table, values: { ID: 2, NAME: 'Grace', EMAIL: 'grace@x.io' } });
    await driver.runQuery(ins2.sql, { params: ins2.params });

    let rows = await driver.runQuery(`SELECT * FROM ${table} ORDER BY id`);
    expect(rows.rowCount).toBe(2);
    const id = (rows.rows[0] as { ID: number }).ID;

    const upd = buildDml(engine, { op: 'update', table, pk: { ID: id }, values: { NAME: 'Linus' } });
    await driver.runQuery(upd.sql, { params: upd.params });
    rows = await driver.runQuery(`SELECT name FROM ${table} WHERE id = ${id}`);
    expect((rows.rows[0] as { NAME: string }).NAME).toBe('Linus');

    const del = buildDml(engine, { op: 'delete', table, pk: { ID: id } });
    await driver.runQuery(del.sql, { params: del.params });
    rows = await driver.runQuery(`SELECT COUNT(*) AS n FROM ${table}`);
    expect(Number((rows.rows[0] as { N: number }).N)).toBe(1);
  });

  it('tablePreview honors WHERE + orderBy', async () => {
    const res = await driver.tablePreview(owner, TABLE, {
      limit: 10,
      offset: 0,
      orderBy: { column: 'NAME', dir: 'asc' },
      where: [{ column: 'NAME', op: '=', value: 'Grace' }],
    });
    expect(res.rows.length).toBe(1);
    expect((res.rows[0] as { NAME: string }).NAME).toBe('Grace');
  });

  it('reports foreign keys', async () => {
    await driver.runQuery(
      buildDdl(engine, 'create', {
        create: {
          table: child,
          columns: [
            { name: 'id', type: 'NUMBER', primaryKey: true, autoIncrement: true, nullable: false },
            { name: 'parent_id', type: 'NUMBER' },
          ],
        },
      })[0],
    );
    await driver.runQuery(
      `ALTER TABLE ${child} ADD CONSTRAINT it_fk_parent FOREIGN KEY (parent_id) REFERENCES ${table} (id)`,
    );
    const info = await driver.describeTable(owner, CHILD);
    expect(info.foreignKeys?.some((fk) => fk.refTable === TABLE && fk.columns.includes('PARENT_ID'))).toBe(true);
  });
});
