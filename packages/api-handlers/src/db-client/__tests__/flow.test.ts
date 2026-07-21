import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiContext } from '@mcp/api-bus';
import { sharedDbConnectionManager } from '@mcp/db-drivers';
import { createDbClientHandlers } from '../index.js';
import type { HandlerDeps } from '../../types.js';

/**
 * End-to-end smoke of the `dbClient` handler surface — exactly the path the IPC
 * channel drives: connect → introspect → query → editRow → ddl. Reproduces the
 * "Not connected" regression class (engine/read-only metadata must resolve from
 * the SHARED manager, not a per-instance closure) and the read-only guard.
 *
 * Uses a temp SQLite file (no network). It loads better-sqlite3, so it shares
 * the store's native-ABI gate — run after `pnpm node:rebuild` if the ABI drifts.
 */
const handlers = createDbClientHandlers({} as HandlerDeps);
const ctx = {} as ApiContext;
const dir = mkdtempSync(join(tmpdir(), 'dbflow-'));

afterAll(async () => {
  await sharedDbConnectionManager().closeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('dbClient handler flow (sqlite)', () => {
  const filePath = join(dir, 'flow.sqlite');
  const cid = 'test:rw';

  it('connect stores engine metadata on the shared manager', async () => {
    const res = await handlers.connect({ spec: { connectionId: cid, engine: 'sqlite', filePath } }, ctx);
    expect(res.serverVersion).toMatch(/SQLite/);
    // The metadata MUST live on the shared manager (the regression fix).
    expect(sharedDbConnectionManager().getMeta(`conn:${cid}`)).toMatchObject({ engine: 'sqlite', readOnly: false });
  });

  it('runs DDL + DML and introspects', async () => {
    await handlers.query(
      { connectionId: cid, sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)' },
      ctx,
    );
    await handlers.query({ connectionId: cid, sql: `INSERT INTO users (name, email) VALUES ('Ada', 'ada@x.io')` }, ctx);

    const schemas = await handlers.introspect({ connectionId: cid }, ctx);
    expect(schemas.schemas).toContain('main');
    const tables = await handlers.introspect({ connectionId: cid, schema: 'main' }, ctx);
    expect(tables.tables.map((t) => t.name)).toContain('users');

    const info = await handlers.describeTable({ connectionId: cid, schema: 'main', table: 'users' }, ctx);
    expect(info.columns.find((c) => c.name === 'id')?.isPrimaryKey).toBe(true);

    const rows = await handlers.tableRows({ connectionId: cid, schema: 'main', table: 'users', limit: 10, offset: 0 }, ctx);
    expect(rows.rowCount).toBe(1);

    const catalog = await handlers.catalog({ connectionId: cid, force: true }, ctx);
    expect(catalog.objects).toContainEqual({ kind: 'table', name: 'users', schema: 'main' });
    await expect(handlers.searchCatalog({ connectionId: cid, query: 'USER' }, ctx)).resolves.toContainEqual({
      kind: 'table', name: 'users', schema: 'main',
    });
  });

  it('editRow: dryRun previews, then applies a PK-scoped UPDATE', async () => {
    const preview = await handlers.editRow(
      { connectionId: cid, op: 'update', table: 'users', pk: { id: 1 }, values: { name: 'Linus' }, dryRun: true },
      ctx,
    );
    expect(preview.sql).toMatch(/UPDATE .*users.* SET .*name.* WHERE .*id.* = 1/i);
    expect(preview.result).toBeUndefined(); // dryRun never executes

    await handlers.editRow({ connectionId: cid, op: 'update', table: 'users', pk: { id: 1 }, values: { name: 'Linus' } }, ctx);
    const after = await handlers.query({ connectionId: cid, sql: 'SELECT name FROM users WHERE id = 1' }, ctx);
    expect(after.rows[0].name).toBe('Linus');
  });

  it('editRows applies parameterized changes atomically and rolls the whole batch back on failure', async () => {
    const preview = await handlers.editRows({
      connectionId: cid,
      changes: [
        { op: 'update', table: 'users', pk: { id: 1 }, values: { name: "O'Hara" } },
        { op: 'insert', table: 'users', values: { id: 2, name: 'Grace', email: 'grace@x.io' } },
      ],
      dryRun: true,
    }, ctx);
    expect(preview.sql).toContain("O''Hara");

    await handlers.editRows({
      connectionId: cid,
      changes: [
        { op: 'update', table: 'users', pk: { id: 1 }, values: { name: "O'Hara" } },
        { op: 'insert', table: 'users', values: { id: 2, name: 'Grace', email: 'grace@x.io' } },
      ],
    }, ctx);
    const committed = await handlers.query({ connectionId: cid, sql: 'SELECT id, name FROM users ORDER BY id' }, ctx);
    expect(committed.rows).toMatchObject([{ id: 1, name: "O'Hara" }, { id: 2, name: 'Grace' }]);

    await expect(handlers.editRows({
      connectionId: cid,
      changes: [
        { op: 'update', table: 'users', pk: { id: 1 }, values: { name: 'Should rollback' } },
        { op: 'insert', table: 'users', values: { id: 2, name: 'Duplicate' } },
      ],
    }, ctx)).rejects.toThrow();
    const rolledBack = await handlers.query({ connectionId: cid, sql: 'SELECT name FROM users WHERE id = 1' }, ctx);
    expect(rolledBack.rows[0].name).toBe("O'Hara");
  });

  it('queryBatch keeps statements on one session, returns every result and rolls back failures', async () => {
    const batch = await handlers.queryBatch({
      connectionId: cid,
      statements: [
        { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [3, 'Batch'] },
        { sql: 'SELECT name FROM users WHERE id = ?', params: [3] },
      ],
    }, ctx);
    expect(batch.results).toHaveLength(2);
    expect(batch.results[1].rows[0].name).toBe('Batch');

    await expect(handlers.queryBatch({
      connectionId: cid,
      statements: [
        { sql: 'UPDATE users SET name = ? WHERE id = ?', params: ['Nope', 1] },
        { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [3, 'Duplicate'] },
      ],
    }, ctx)).rejects.toThrow(/rolled back/i);
    const after = await handlers.query({ connectionId: cid, sql: 'SELECT name FROM users WHERE id = 1' }, ctx);
    expect(after.rows[0].name).toBe("O'Hara");
  });

  it('ddl: dryRun previews an ALTER without touching the schema', async () => {
    const preview = await handlers.ddl(
      { connectionId: cid, op: 'alter', spec: { alter: { table: 'users', actions: [{ kind: 'addColumn', column: { name: 'age', type: 'INTEGER' } }] } }, dryRun: true },
      ctx,
    );
    expect(preview.sql).toMatch(/ALTER TABLE .*users.* ADD COLUMN .*age/i);
    expect(preview.result).toBeUndefined();
  });

  it('previews and applies selected schema migrations, including sequential SQLite rebuilds', async () => {
    await handlers.query({ connectionId: cid, sql: 'ALTER TABLE users ADD COLUMN legacy_a TEXT' }, ctx);
    await handlers.query({ connectionId: cid, sql: 'ALTER TABLE users ADD COLUMN legacy_b TEXT' }, ctx);
    const changes = [
      { op: 'alter' as const, spec: { alter: { schema: 'main', table: 'users', actions: [{ kind: 'modifyColumn' as const, name: 'legacy_a', column: { name: 'legacy_a', type: 'INTEGER', nullable: true } }] } } },
      { op: 'alter' as const, spec: { alter: { schema: 'main', table: 'users', actions: [{ kind: 'modifyColumn' as const, name: 'legacy_b', column: { name: 'legacy_b', type: 'BLOB', nullable: true } }] } } },
    ];
    const preview = await handlers.migration({ connectionId: cid, changes, dryRun: true }, ctx);
    expect(preview.sql).toContain('legacy_a');
    expect(preview.atomic).toBe(false);

    const applied = await handlers.migration({ connectionId: cid, changes }, ctx);
    expect(applied.applied).toBe(2);
    const info = await handlers.describeTable({ connectionId: cid, schema: 'main', table: 'users' }, ctx);
    expect(info.columns.find((column) => column.name === 'legacy_a')?.dataType).toBe('INTEGER');
    expect(info.columns.find((column) => column.name === 'legacy_b')?.dataType).toBe('BLOB');
    expect((await handlers.query({ connectionId: cid, sql: 'SELECT COUNT(*) AS n FROM users' }, ctx)).rows[0].n).toBe(3);
  });
});

describe('dbClient read-only guard', () => {
  const filePath = join(dir, 'ro.sqlite');
  const cid = 'test:ro';

  it('blocks writes on a read-only connection', async () => {
    // Native SQLite read-only mode requires an existing file; seed it exactly
    // as a real saved connection would already exist on disk.
    const seed = await import('@mcp/db-drivers').then(({ createSqliteDriver }) =>
      createSqliteDriver({ engine: 'sqlite', filePath }),
    );
    await seed.runQuery('CREATE TABLE seed (id INTEGER PRIMARY KEY)');
    await seed.close();
    await handlers.connect({ spec: { connectionId: cid, engine: 'sqlite', filePath, readOnly: true } }, ctx);
    await handlers.query({ connectionId: cid, sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)' }, ctx).catch(() => void 0);

    // editRow on a read-only connection is rejected.
    await expect(
      handlers.editRow({ connectionId: cid, op: 'insert', table: 't', values: { id: 1 } }, ctx),
    ).rejects.toThrow(/read-only/i);

    // A non-SELECT query is also rejected.
    await expect(
      handlers.query({ connectionId: cid, sql: 'DELETE FROM t' }, ctx),
    ).rejects.toThrow(/read-only/i);

    // Read-shaped SQL that creates a table (SQL Server/PostgreSQL) is rejected.
    await expect(
      handlers.query({ connectionId: cid, sql: 'SELECT * INTO copied FROM seed' }, ctx),
    ).rejects.toThrow(/read-only/i);

    // …but a SELECT is allowed.
    const ok = await handlers.query({ connectionId: cid, sql: 'SELECT 1 AS one' }, ctx);
    expect(ok.rows[0].one).toBe(1);
  });

  it('reports "not connected" after disconnect', async () => {
    await handlers.disconnect({ connectionId: cid }, ctx);
    await expect(handlers.query({ connectionId: cid, sql: 'SELECT 1' }, ctx)).rejects.toThrow(/not connected/i);
  });
});
