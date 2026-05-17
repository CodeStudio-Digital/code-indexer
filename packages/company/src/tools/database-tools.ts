/**
 * db_* tools — let the agent discover and operate the databases the
 * user registered for this session (Databases tab).
 *
 * Full-access by design: the user explicitly opted in to
 * SELECT/INSERT/UPDATE/DELETE/DDL from the agent. Confirmation gates
 * live in plan mode, not here.
 *
 * Injection: `setDatabaseToolStores` is called from server.ts at boot
 * (same pattern as `setEnvToolStore`). Tools resolve the driver by
 * reading `company_session_databases` → `env_keys` → `company_session_envs`,
 * so editing a connection string via the Env tab automatically reflects
 * on the next call.
 */

import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { CompanySessionDatabaseStore } from '@mcp/store/company-session-database-store.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import type { CompanySessionDatabase } from '@mcp/company/database-types.js';
import { PROVIDERS } from '@mcp/company/database-providers.js';
import { getDriver, type TableInfo } from '@mcp/company/tools/database-driver.js';

const MAX_RESULT_CHARS = 50_000;

// ─── Module-level bindings (setter pattern) ──────────────────────

let dbStore: CompanySessionDatabaseStore | null = null;
let envStore: CompanySessionEnvStore | null = null;

export function setDatabaseToolStores(
  databaseStore: CompanySessionDatabaseStore | null,
  envVarStore: CompanySessionEnvStore | null,
): void {
  dbStore = databaseStore;
  envStore = envVarStore;
}

// ─── Resolution helpers ──────────────────────────────────────────

function sessionIdOf(ctx: ToolContext): number | null {
  // Database configs are project-wide → resolve to root via the
  // orchestrator's effective id when available.
  const orch = ctx.companyContext?.orchestrator as { effectiveSessionId?: number } | undefined;
  if (typeof orch?.effectiveSessionId === 'number') return orch.effectiveSessionId;
  const raw = ctx.companyContext?.companySessionId;
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'number' ? raw : Number(raw);
}

interface ResolvedTarget {
  session: number;
  database: CompanySessionDatabase;
}

function resolveTarget(
  ctx: ToolContext,
  labelArg: unknown,
): { ok: true; value: ResolvedTarget } | { ok: false; error: string } {
  if (!dbStore || !envStore) {
    return { ok: false, error: 'db tools unavailable (stores not wired)' };
  }
  const sessionId = sessionIdOf(ctx);
  if (sessionId === null) {
    return { ok: false, error: 'db tools require a company session context' };
  }
  const dbs = dbStore.list(sessionId);
  if (dbs.length === 0) {
    return {
      ok: false,
      error: 'No databases configured. Ask the user to add one in the Databases tab.',
    };
  }
  const label = typeof labelArg === 'string' ? labelArg.trim() : '';
  if (!label) {
    if (dbs.length === 1) return { ok: true, value: { session: sessionId, database: dbs[0] } };
    return {
      ok: false,
      error:
        `Multiple databases configured (${dbs.map((d) => d.label).join(', ')}). ` +
        `Pass the \`label\` arg — call db_list if unsure which one to use.`,
    };
  }
  const picked = dbs.find((d) => d.label === label);
  if (!picked) {
    return {
      ok: false,
      error:
        `No database with label '${label}'. Known labels: ` +
        dbs.map((d) => d.label).join(', '),
    };
  }
  return { ok: true, value: { session: sessionId, database: picked } };
}

async function resolveDriver(target: ResolvedTarget) {
  const spec = PROVIDERS[target.database.provider];
  const envKey = target.database.env_keys[spec.connectionField];
  if (!envKey) {
    throw new Error(
      `Database '${target.database.label}' has no env mapping for ${spec.connectionField}`,
    );
  }
  const row = envStore!.get(target.session, envKey);
  if (!row || !row.value) {
    throw new Error(
      `Env var '${envKey}' for database '${target.database.label}' is empty. ` +
        `Set it in the Databases or Env tab.`,
    );
  }
  return getDriver(target.session, target.database.id, spec.wireProtocol, row.value);
}

// ─── Tools ───────────────────────────────────────────────────────

const dbList: CoderTool = {
  name: 'db_list',
  description:
    'List every database registered for this session (from the Databases tab). Returns one ' +
    'entry per instance: label, provider, whether it is the primary of that provider, and the ' +
    'env keys that hold its credentials. Use this BEFORE calling db_query/db_schema when you ' +
    'are unsure which label to target — or when the agent is first booting up and has no idea ' +
    'what data sources are available.',
  source: 'native',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx): Promise<ToolResult> => {
    if (!dbStore) return err('db tools unavailable (stores not wired)');
    const sessionId = sessionIdOf(ctx);
    if (sessionId === null) return err('db_list requires a company session context');
    const dbs = dbStore.list(sessionId);
    if (dbs.length === 0) {
      return ok('(no databases configured — ask the user to add one in the Databases tab)');
    }
    const lines = dbs.map((d) => {
      const envKeys = Object.entries(d.env_keys)
        .map(([field, key]) => `${field}→${key}`)
        .join(', ');
      const meta = Object.keys(d.metadata).length
        ? ` meta={${Object.entries(d.metadata)
            .map(([k, v]) => `${k}:${v}`)
            .join(', ')}}`
        : '';
      const primary = d.is_primary ? ' [primary]' : '';
      return `- ${d.label} (${d.provider}${primary}) envs={${envKeys}}${meta}`;
    });
    return ok(lines.join('\n'));
  },
};

const dbSchema: CoderTool = {
  name: 'db_schema',
  description:
    'Introspect tables and columns of a registered database. Returns one block per table with ' +
    'columns, data types, nullability, and primary-key flags. For Postgres the default `schema` ' +
    'is "public"; for MySQL the default is the database in the connection URL. `label` is ' +
    'required when more than one database is configured — call db_list first if unsure.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description:
          "DB label from the Databases tab (e.g. 'main', 'analytics'). " +
          'Optional when exactly one DB is configured.',
      },
      schema: {
        type: 'string',
        description: 'Schema / database name. Defaults to public (PG) or current DB (MySQL).',
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const resolved = resolveTarget(ctx, args.label);
    if (!resolved.ok) return err(resolved.error);
    let tables: TableInfo[];
    try {
      const driver = await resolveDriver(resolved.value);
      tables = await driver.schema(
        typeof args.schema === 'string' && args.schema ? args.schema : undefined,
      );
    } catch (e) {
      return err(`db_schema failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (tables.length === 0) {
      return ok(`(no tables in schema — database is empty or the schema name is wrong)`);
    }
    const body = tables
      .map((t) => {
        const cols = t.columns
          .map(
            (c) =>
              `    ${c.name}: ${c.dataType}${c.nullable ? ' NULL' : ' NOT NULL'}` +
              `${c.isPrimaryKey ? ' [PK]' : ''}`,
          )
          .join('\n');
        return `TABLE ${t.schema}.${t.name}\n${cols}`;
      })
      .join('\n\n');
    return ok(truncate(body));
  },
};

const dbQuery: CoderTool = {
  name: 'db_query',
  description:
    'Execute arbitrary SQL against a registered database. Full access: SELECT, INSERT, UPDATE, ' +
    'DELETE, and DDL (CREATE/DROP/ALTER) are allowed — the user opted in. Use parameterized ' +
    'queries via `params` to avoid injection when interpolating user/agent-derived values. ' +
    'Returns up to 50KB of rows; large result sets are truncated with a marker. `label` is ' +
    'required when more than one database is configured.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'DB label from the Databases tab. Optional when exactly one DB exists.',
      },
      sql: { type: 'string', description: 'SQL to execute.' },
      params: {
        type: 'array',
        description:
          'Positional parameters for the query. Postgres uses $1,$2,…; MySQL uses ? placeholders.',
        items: {},
      },
    },
    required: ['sql'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const sql = typeof args.sql === 'string' ? args.sql : '';
    if (!sql.trim()) return err('db_query: sql (non-empty string) required');
    const resolved = resolveTarget(ctx, args.label);
    if (!resolved.ok) return err(resolved.error);
    const params = Array.isArray(args.params) ? (args.params as unknown[]) : undefined;
    try {
      const driver = await resolveDriver(resolved.value);
      const result = await driver.query(sql, params);
      const rendered = renderQueryResult(result);
      return ok(truncate(rendered));
    } catch (e) {
      return err(`db_query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const databaseTools: CoderTool[] = [dbList, dbSchema, dbQuery];

// ─── Output rendering ────────────────────────────────────────────

function renderQueryResult(result: {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  fields: Array<{ name: string }>;
}): string {
  if (result.rows.length === 0) {
    return `OK — ${result.rowCount} row(s) affected.`;
  }
  const columnNames =
    result.fields.length > 0
      ? result.fields.map((f) => f.name)
      : Object.keys(result.rows[0]);
  const header = columnNames.join(' | ');
  const sep = columnNames.map(() => '---').join(' | ');
  const body = result.rows
    .map((row) => columnNames.map((name) => stringifyCell(row[name])).join(' | '))
    .join('\n');
  return `rows=${result.rows.length} rowCount=${result.rowCount}\n${header}\n${sep}\n${body}`;
}

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[truncated — full result exceeded ${MAX_RESULT_CHARS} chars]`
  );
}
