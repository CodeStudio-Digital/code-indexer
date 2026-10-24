/**
 * End-to-end db_* tools over a REAL DbClientStore (sqlite temp) + a REAL
 * sqlite data file — no network, no mocks in the data path.
 *
 * ABI: imports better-sqlite3, which in this repo is built for the ELECTRON
 * ABI. Run via Electron-as-node, e.g.:
 *   ELECTRON_RUN_AS_NODE=1 <electron.exe> node_modules/vitest/vitest.mjs run \
 *     packages/code-agent/src/tools/db/__tests__/tools.integration.test.ts --pool=forks
 * ERR_DLOPEN_FAILED under plain node is an ABI mismatch, not a logic bug.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DbClientStore } from '@mcp/store/db-client-store.js';
import { dbClient174 } from '@mcp/store/migrations/174_db_client.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { dbTools, setDbSecretDecryptor, setDbToolsStores } from '../index.js';

const byName = (name: string): CoderTool => dbTools.find((t) => t.name === name)!;
const ctx = { cwd: tmpdir(), projectName: 't', projectId: 1 } as unknown as ToolContext;

let dir: string;
let metaDb: InstanceType<typeof Database>;
let store: DbClientStore;
let mainConnectionId: number;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbtools-'));
  // Data DB the connections point at.
  const dataPath = join(dir, 'data.sqlite');
  const data = new Database(dataPath);
  data.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
             INSERT INTO items (name) VALUES ('a'), ('b'), ('c');`);
  data.close();
  // Meta DB with the real migration-174 schema (ssh_hosts stub satisfies the
  // FK that migration 173 provides in the real DB).
  metaDb = new Database(join(dir, 'meta.sqlite'));
  metaDb.exec('CREATE TABLE IF NOT EXISTS ssh_hosts (id INTEGER PRIMARY KEY)');
  dbClient174.up(metaDb);
  store = new DbClientStore(metaDb);
  mainConnectionId = store.createConnection({ project_id: 1, label: 'main', engine: 'sqlite', file_path: dataPath }).id;
  store.createConnection({ project_id: 1, label: 'ro', engine: 'sqlite', file_path: dataPath, is_read_only: true });
  setDbToolsStores(store, null);
  setDbSecretDecryptor(() => {
    throw new Error('no secrets expected in this test');
  });
});

afterAll(async () => {
  const { sharedDbConnectionManager } = await import('@mcp/db-drivers/manager.js');
  await sharedDbConnectionManager().closeAll();
  setDbToolsStores(null, null);
  setDbSecretDecryptor(null);
  metaDb.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
});

describe('db_list', () => {
  it('lists connections with engine/kind/read-only, without connecting', async () => {
    const r = await byName('db_list').handler({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('- main (sqlite, relational)');
    expect(r.content).toContain('- ro (sqlite, relational [read-only])');
  });
});

describe('agent database pool isolation', () => {
  it('does not close another connection whose numeric id shares a prefix', async () => {
    const { acquireAgentDriver, agentPoolKey } = await import('../pool.js');
    const { sharedDbConnectionManager } = await import('@mcp/db-drivers/manager.js');
    const source = store.getConnection(mainConnectionId)!;
    const neighbor = { ...source, project_id: 999_901, id: 20 };
    const target = { ...source, project_id: 999_901, id: 2 };
    const existing = await acquireAgentDriver(neighbor);
    await acquireAgentDriver(target);
    expect(sharedDbConnectionManager().get(agentPoolKey(neighbor))).toBe(existing.driver);
    expect((await existing.driver.runQuery('SELECT 1 AS alive')).rows).toEqual([{ alive: 1 }]);
  });
});

describe('db_query', () => {
  const dbQuery = byName('db_query');

  it('requires the connection arg when more than one is registered', async () => {
    const r = await dbQuery.handler({ sql: 'SELECT 1' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Multiple connections available (main, ro)');
  });

  it('SELECT end-to-end renders the markdown table + footer', async () => {
    const r = await dbQuery.handler({ connection: 'main', sql: 'SELECT id, name FROM items ORDER BY id' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('id | name');
    expect(r.content).toContain('1 | a');
    expect(r.content).toContain('rows=3 truncated=false');
  });

  it('max_rows caps the result and flags truncation', async () => {
    const r = await dbQuery.handler({ connection: 'main', sql: 'SELECT * FROM items', max_rows: 2 }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('rows=2 truncated=true');
    expect(r.content).toContain('LIMIT/OFFSET');
    expect(r.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'db-driver-row-cap',
        outputSize: 2,
        inputSizeExact: false,
        unit: 'rows',
        recoverable: true,
      }),
    ]);
  });

  it('keeps the complete bounded driver page for central spill/reduction', async () => {
    const r = await dbQuery.handler({
      connection: 'main',
      sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1200) SELECT x FROM n',
      max_rows: 1000,
    }, ctx);

    expect(r.content).toContain('rows=1000 truncated=true');
    expect(r.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'db-driver-row-cap',
        // The bounded SQLite cursor proves one omitted row without scanning
        // all 1,200. inputSizeExact remains false for this lower bound.
        inputSize: 1001,
        inputSizeExact: false,
        outputSize: 1000,
        unit: 'rows',
      }),
    ]);
  });

  it('does not advertise a mutating RETURNING result as recoverable by rerun', async () => {
    const r = await dbQuery.handler({
      connection: 'main',
      sql: 'UPDATE items SET name = name RETURNING id, name',
      max_rows: 2,
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'db-driver-row-cap',
        outputSize: 2,
        recoverable: false,
      }),
    ]);
  });

  it('writes work on a writable connection', async () => {
    const w = await dbQuery.handler({ connection: 'main', sql: "INSERT INTO items (name) VALUES ('d')" }, ctx);
    expect(w.isError).toBeFalsy();
    expect(w.content).toContain('1 row(s) affected');
    const check = await dbQuery.handler({ connection: 'main', sql: 'SELECT COUNT(*) AS n FROM items' }, ctx);
    expect(check.content).toContain('4');
  });

  it('read-only connection: SELECT allowed, INSERT and SELECT INTO refused', async () => {
    const sel = await dbQuery.handler({ connection: 'ro', sql: 'SELECT COUNT(*) AS n FROM items' }, ctx);
    expect(sel.isError).toBeFalsy();
    const ins = await dbQuery.handler({ connection: 'ro', sql: "INSERT INTO items (name) VALUES ('x')" }, ctx);
    expect(ins.isError).toBe(true);
    expect(ins.content).toContain('read-only — writes are blocked');
    const selectInto = await dbQuery.handler({ connection: 'ro', sql: 'SELECT * INTO copied FROM items' }, ctx);
    expect(selectInto.isError).toBe(true);
    expect(selectInto.content).toContain('read-only — writes are blocked');
  });

  it('reopens an existing agent pool immediately when read-only is toggled', async () => {
    store.updateConnection(mainConnectionId, { is_read_only: true });
    const blocked = await dbQuery.handler({ connection: 'main', sql: "INSERT INTO items (name) VALUES ('blocked')" }, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('read-only — writes are blocked');

    store.updateConnection(mainConnectionId, { is_read_only: false });
    const allowed = await dbQuery.handler({ connection: 'main', sql: "INSERT INTO items (name) VALUES ('after-toggle')" }, ctx);
    expect(allowed.isError).toBeFalsy();
  });

  it('refuses multiple statements', async () => {
    const r = await dbQuery.handler({ connection: 'main', sql: 'SELECT 1; SELECT 2' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('ONE statement per call');
  });

  it('unknown connection name → didactic error with known names', async () => {
    const r = await dbQuery.handler({ connection: 'nope', sql: 'SELECT 1' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("No connection named 'nope'");
    expect(r.content).toContain('main, ro');
  });
});

describe('db_schema', () => {
  it('lists compactly, then introspects one table end-to-end', async () => {
    const catalog = await byName('db_schema').handler({ connection: 'main' }, ctx);
    expect(catalog.isError).toBeFalsy();
    expect(catalog.content).toContain('SCHEMA CATALOG');
    expect(catalog.content).toContain('main.items');
    expect(catalog.content).not.toContain('id: INTEGER');

    const detail = await byName('db_schema').handler({ connection: 'main', table: 'items' }, ctx);
    expect(detail.isError).toBeFalsy();
    expect(detail.content).toContain('TABLE main.items');
    expect(detail.content).toContain('id: INTEGER');
    expect(detail.content).toContain('[PK]');
    expect(detail.content).toContain('name: TEXT NOT NULL');
  });
});

describe('db_command', () => {
  it('is refused on a relational connection', async () => {
    const r = await byName('db_command').handler({ connection: 'main', command: { args: ['GET', 'k'] } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('relational');
    expect(r.content).toContain('db_query');
  });
});

describe('company scope', () => {
  it('names connections <slug>:<label> via the session-projects port', async () => {
    setDbToolsStores(store, {
      listCompanySessionProjects: () => [{ project_id: 1, label: 'app' }],
    });
    const companyCtx = {
      ...ctx,
      projectId: undefined,
      companyContext: {
        orchestrator: {
          effectiveSessionId: '11111111-1111-4111-8111-111111111111',
        },
        companySessionId: '11111111-1111-4111-8111-111111111111',
      },
    } as unknown as ToolContext;
    const r = await byName('db_list').handler({}, companyCtx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('- app:main (sqlite');
    expect(r.content).toContain('- app:ro (sqlite');
    setDbToolsStores(store, null);
  });
});
