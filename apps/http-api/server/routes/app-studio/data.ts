/**
 * Route — "Seus dados": introspecção do banco D1 LOCAL do workspace
 * (o SQLite do miniflare em `.wrangler/state/v3/d1/`), traduzida para
 * fichas leigo-friendly com labels humanos vindos da spec.
 *
 *   GET /api/app-studio/sessions/:id/data            → todas as tabelas
 *       (colunas + contagem + 3 linhas de exemplo)
 *   GET /api/app-studio/sessions/:id/data?table=X    → até 100 linhas de X
 *
 * Read-only por construção (better-sqlite3 { readonly }); tabelas internas
 * (sqlite_*, _cf_*, d1_migrations) ficam de fora.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Hono } from 'hono';
import type DatabaseConstructor from 'better-sqlite3';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { parseIdParam, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;

const SHEET_LIMIT = 100;
const SAMPLE_LIMIT = 3;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** SQLite local do D1 (miniflare): .wrangler/state/v3/d1/**\/*.sqlite. */
function findLocalD1File(workspaceDir: string): string | null {
  const base = join(workspaceDir, '.wrangler', 'state', 'v3', 'd1');
  if (!existsSync(base)) return null;
  const stack = [base];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.name.endsWith('.sqlite')) return abs;
    }
  }
  return null;
}

function isUserTable(name: string): boolean {
  return !name.startsWith('sqlite_') && !name.startsWith('_cf_') && name !== 'd1_migrations';
}

type Row = Record<string, unknown>;

export function mountAppStudioDataRoutes(app: Hono, deps: ServerDeps): void {
  const { appStudioStore, db } = deps;

  app.get('/api/app-studio/sessions/:id/data', (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const project = db.getProject(session.project_id);
    if (!project?.root_path) return c.json({ error: 'Workspace project missing.' }, 500);

    const dbFile = findLocalD1File(project.root_path);
    if (!dbFile) return c.json({ tables: null, reason: 'not-provisioned' });

    const spec = parseAppSpec(session.spec_json);
    const entityByName = new Map(spec?.database.entities.map((e) => [e.name, e]) ?? []);

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

      const tables = names.map((name) => {
        const entity = entityByName.get(name);
        const columns = (sqlite!.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string }>).map(
          (col) => ({
            name: col.name,
            type: col.type,
            label: entity?.fields.find((f) => f.name === col.name)?.label ?? col.name,
          }),
        );
        const count = (sqlite!.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
        const samples = sqlite!.prepare(`SELECT * FROM "${name}" LIMIT ${SAMPLE_LIMIT}`).all() as Row[];
        return { name, label: entity?.label ?? name, columns, row_count: count, samples };
      });
      return c.json({ tables });
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
}
