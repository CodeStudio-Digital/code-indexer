/**
 * Route — "Seus dados": introspecção do banco D1 LOCAL do workspace
 * (o SQLite do miniflare em `.wrangler/state/v3/d1/`), traduzida para
 * fichas leigo-friendly com labels humanos vindos da spec.
 *
 *   GET /api/app-studio/apps/:id/data                → todas as tabelas
 *       (colunas + contagem + 3 linhas de exemplo)
 *   GET /api/app-studio/apps/:id/data?table=X        → até 100 linhas de X
 *   POST /api/app-studio/apps/:id/data/provision     → aplica migrations + seed locais
 *   POST /api/app-studio/apps/:id/data/query         → consulta SELECT read-only
 *
 * Read-only por construção (better-sqlite3 { readonly }); tabelas internas
 * (sqlite_*, _cf_*, d1_migrations) ficam de fora.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type DatabaseConstructor from 'better-sqlite3';
import { listSqlMigrations, readIfExists, sqlHasStatements } from '@mcp/app-studio/verification/workspace-checks.js';
import { findLocalD1File } from '@mcp/app-studio/local-db.js';
import { parseAppPlan } from '@mcp/app-studio/plan/types.js';
import { readDbStatus } from '@mcp/app-studio/status-files.js';
import { hasMultipleStatements, isReadStatement } from '@mcp/db-drivers/sql/read-guard.js';
import { ensureAppStudioDbConnection } from '@mcp/company/tools/app-studio/db-client-bridge.js';
import { getDatabaseProvisioner } from '@mcp/services/app-studio/index.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;

const SHEET_LIMIT = 100;
const SAMPLE_LIMIT = 3;
const QUERY_LIMIT = 200;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isUserTable(name: string): boolean {
  return !name.startsWith('sqlite_') && !name.startsWith('_cf_') && name !== 'd1_migrations';
}

type Row = Record<string, unknown>;

interface SqliteColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface SqliteForeignKeyInfo {
  table: string;
  from: string;
  to: string;
}

interface AppDataProvisionState {
  needed: boolean;
  issues: string[];
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

function assertReadOnlyQuery(sql: string): string | null {
  const trimmed = stripTrailingSemicolon(sql);
  if (!trimmed) return 'Query is required.';
  if (hasMultipleStatements(trimmed)) return 'Use only one SELECT query.';
  if (!/^(select|with)\b/i.test(trimmed)) return 'Only SELECT queries are allowed here.';
  if (!isReadStatement(trimmed)) return 'This query is not read-only.';
  return null;
}

function currentProvisionState(workspaceDir: string, dbFile: string | null): AppDataProvisionState {
  const issues: string[] = [];
  const migrations = listSqlMigrations(workspaceDir);
  const db = readDbStatus(workspaceDir);

  if (!dbFile || !db?.local_ready) {
    issues.push('not-provisioned');
  } else {
    const missing = migrations.filter((name) => !db.applied.includes(name));
    if (missing.length > 0) issues.push(`migrations-missing:${missing.join(',')}`);

    const seedSql = readIfExists(join(workspaceDir, 'seeds', 'seed.sql'));
    if (sqlHasStatements(seedSql ?? '') && !db.seeded) issues.push('seed-missing');
  }

  return { needed: issues.length > 0, issues };
}

export function mountAppStudioDataRoutes(app: Hono, deps: ServerDeps): void {
  const { appStudioStore, db } = deps;

  function syncNativeDbConnection(session: NonNullable<ReturnType<typeof appStudioStore.getSession>>, dbFile: string) {
    return ensureAppStudioDbConnection({
      listConnections: (projectId) => deps.dbClientFor(projectId).listConnections(projectId),
      createConnection: (input) => deps.dbClientFor(input.project_id).createConnection(input),
      updateConnection: (projectId, id, patch) => deps.dbClientFor(projectId).updateConnection(id, patch),
    }, session, dbFile);
  }

  app.get('/api/app-studio/apps/:id/data', (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const project = db.getProject(session.project_id);
    if (!project?.root_path) return c.json({ error: 'Workspace project missing.' }, 500);

    const dbFile = findLocalD1File(project.root_path);
    const provision = currentProvisionState(project.root_path, dbFile);
    if (!dbFile) return c.json({ tables: null, reason: 'not-provisioned', provision });
    syncNativeDbConnection(session, dbFile);

    const plan = parseAppPlan(appStudioStore.getLatestPlanRevision(id)?.plan_json ?? null);
    const entityByName = new Map(plan?.data.entities.map((entity) => [entity.name, entity]) ?? []);

    let sqlite: InstanceType<typeof Database> | null = null;
    try {
      sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
      const tableParam = c.req.query('table');

      if (tableParam) {
        // Planilha de UMA tabela (o nome vem da nossa própria listagem,
        // mas valida como identificador mesmo assim — nunca interpolar livre).
        if (!IDENT_RE.test(tableParam) || !isUserTable(tableParam)) {
          return c.json({ error: `Unknown table '${tableParam}'.` }, 400);
        }
        const columns = (sqlite.prepare(`PRAGMA table_info("${tableParam}")`).all() as Array<{ name: string; type: string }>);
        if (columns.length === 0) return c.json({ error: `Unknown table '${tableParam}'.` }, 400);
        const rows = sqlite.prepare(`SELECT * FROM "${tableParam}" LIMIT ${SHEET_LIMIT}`).all() as Row[];
        return c.json({ table: tableParam, columns: columns.map((col) => col.name), rows });
      }

      const names = (
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
      )
        .map((r) => r.name)
        .filter(isUserTable);
      const entityLabel = (name: string) => entityByName.get(name)?.label ?? name;
      const relationPairs = names.flatMap((name) =>
        (sqlite!.prepare(`PRAGMA foreign_key_list("${name}")`).all() as SqliteForeignKeyInfo[])
          .filter((fk) => names.includes(fk.table))
          .map((fk) => ({
            from_table: name,
            from_label: entityLabel(name),
            from_column: fk.from,
            to_table: fk.table,
            to_label: entityLabel(fk.table),
            to_column: fk.to || 'id',
          })),
      );

      const tables = names.map((name) => {
        const entity = entityByName.get(name);
        const fks = sqlite!.prepare(`PRAGMA foreign_key_list("${name}")`).all() as SqliteForeignKeyInfo[];
        const columns = (sqlite!.prepare(`PRAGMA table_info("${name}")`).all() as SqliteColumnInfo[]).map(
          (col) => {
            const planField = entity?.fields.find((f) => f.name === col.name);
            const fk = fks.find((item) => item.from === col.name);
            return {
              name: col.name,
              type: col.type,
              label: planField?.label ?? col.name,
              required: col.notnull === 1 || col.pk > 0 || planField?.required === true,
              primary_key: col.pk > 0,
              references: fk
                ? { table: fk.table, column: fk.to || 'id', label: entityLabel(fk.table) }
                : planField?.references
                  ? { table: planField.references, column: 'id', label: entityLabel(planField.references) }
                  : null,
            };
          },
        );
        const count = (sqlite!.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
        const samples = sqlite!.prepare(`SELECT * FROM "${name}" LIMIT ${SAMPLE_LIMIT}`).all() as Row[];
        const issues: string[] = [];
        if (!columns.some((col) => col.primary_key)) issues.push('no-primary-key');
        for (const col of columns) {
          if (col.name.endsWith('_id') && !col.references) issues.push(`missing-fk:${col.name}`);
        }
        if (count === 0) issues.push('empty-table');
        return {
          name,
          label: entity?.label ?? name,
          columns,
          row_count: count,
          samples,
          relations_out: relationPairs.filter((r) => r.from_table === name),
          relations_in: relationPairs.filter((r) => r.to_table === name),
          health: {
            status: issues.length === 0 ? 'ok' : 'warning',
            issues,
          },
        };
      });
      return c.json({ tables, relations: relationPairs, provision });
    } catch (e) {
      return c.json({ error: `Could not read the local database: ${(e as Error).message}` }, 500);
    } finally {
      try {
        sqlite?.close();
      } catch {
        /* já fechado */
      }
    }
  });

  app.post('/api/app-studio/apps/:id/data/provision', async (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const project = db.getProject(session.project_id);
    if (!project?.root_path) return c.json({ error: 'Workspace project missing.' }, 500);

    let provisioner;
    try {
      provisioner = getDatabaseProvisioner('d1');
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    try {
      const outcome = await provisioner.ensureLocal({
        workspaceDir: project.root_path,
        appSlug: session.app_slug,
        bindingName: 'DB',
      });
      if (!outcome.ok) {
        return c.json({ error: outcome.error ?? 'Local database provisioning failed.' }, 409);
      }
      const dbFile = findLocalD1File(project.root_path);
      const connection = dbFile ? syncNativeDbConnection(session, dbFile).connection : null;
      const provision = currentProvisionState(project.root_path, dbFile);
      return c.json({ ok: true, applied: outcome.applied, connection, provision });
    } catch (e) {
      return c.json({ error: `Local database provisioning failed: ${(e as Error).message}` }, 500);
    }
  });

  app.post('/api/app-studio/apps/:id/data/query', async (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const project = db.getProject(session.project_id);
    if (!project?.root_path) return c.json({ error: 'Workspace project missing.' }, 500);

    const dbFile = findLocalD1File(project.root_path);
    if (!dbFile) return c.json({ error: 'Local database is not provisioned yet.' }, 409);
    syncNativeDbConnection(session, dbFile);
    const body = await parseJsonBody<{ sql?: string }>(c);
    const sql = stripTrailingSemicolon(String(body.sql ?? ''));
    const readError = assertReadOnlyQuery(sql);
    if (readError) return c.json({ error: readError }, 400);

    let sqlite: InstanceType<typeof Database> | null = null;
    const started = Date.now();
    try {
      sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
      const wrapped = `SELECT * FROM (${sql}) LIMIT ${QUERY_LIMIT + 1}`;
      const stmt = sqlite.prepare(wrapped);
      const columns = stmt.columns().map((col) => col.name);
      const rows = stmt.all() as Row[];
      const limited = rows.length > QUERY_LIMIT;
      const visibleRows = limited ? rows.slice(0, QUERY_LIMIT) : rows;
      return c.json({
        columns,
        rows: visibleRows,
        row_count: visibleRows.length,
        limited,
        duration_ms: Date.now() - started,
      });
    } catch (e) {
      return c.json({ error: `Could not run the query: ${(e as Error).message}` }, 400);
    } finally {
      try {
        sqlite?.close();
      } catch {
        /* já fechado */
      }
    }
  });
}
