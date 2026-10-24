/**
 * The `db_*` agent tools (v2) — operate the connections the user registered in
 * the project's Databases tab (migration 174). Replaces the retired
 * @mcp/company database-tools (env-var based). Registered UNCONDITIONALLY and
 * surfaced through the `db` tool tier; the read-only valve reads the SAME
 * pool metadata the UI handlers enforce with.
 */
import type {
  CoderTool,
  ToolContext,
  ToolResult,
  ToolSourceTruncation,
} from '@mcp/code-agent/core/tool.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import { asAbortSignal } from '@mcp/code-agent/core/abort-signal.js';
import { abortableRead } from '@mcp/shared/utils/abortable.js';
import {
  assertMutationFence,
  combinedMutationSignal,
} from '@mcp/code-agent/core/mutation-fence.js';
import { hasMultipleStatements, isReadStatement } from '@mcp/db-drivers/sql/read-guard.js';
import { isWriteCommand } from '@mcp/db-drivers/command-classify.js';
import type { DatabaseDriver, DbCommand, QueryResult, TableRef } from '@mcp/db-drivers/types.js';
import { engineKind } from './scope.js';
import { CONNECTION_PARAM, clampMaxRows, pickFromCtx, resolveToolScope } from './shared.js';
import { scrubDbError } from './resolve-spec.js';
import { acquireAgentDriver } from './pool.js';
import { acquireToolDriver, databaseInvocation } from './invocation.js';
import { cancellableToolRpc } from '../cancellable-rpc.js';
import { renderQueryResult, renderSchema, renderSchemaCatalog } from './render.js';

export const DEFAULT_SCHEMA_PAGE_SIZE = 40;
export const MAX_SCHEMA_PAGE_SIZE = 100;

function renderDbResult(result: QueryResult, ctx: ToolContext, sourceRecoverable: boolean): ToolResult {
  const sourceTruncations: ToolSourceTruncation[] = [];
  let cappedCells = 0;
  let inputChars = 0;
  let outputChars = 0;
  let recoverable = true;
  const content = renderQueryResult(result, {
    outputStore: ctx.toolOutputStore,
    onCellTruncated: (info) => {
      cappedCells += 1;
      inputChars += info.inputChars;
      outputChars += info.outputChars;
      recoverable &&= info.recoverable;
    },
  });
  if (result.truncated === true) {
    sourceTruncations.push({
      technique: 'db-driver-row-cap',
      // Drivers often cannot know the exact total without a second COUNT.
      // rowCount may be exact; otherwise +1 is the smallest truthful proof
      // that at least one row was omitted.
      inputSize: Math.max(result.rowCount, result.rows.length + 1),
      inputSizeExact: false,
      outputSize: result.rows.length,
      unit: 'rows',
      // Re-running a SELECT/read command with pagination is safe. Re-running
      // INSERT/UPDATE/DELETE or a mutating document command is not recovery.
      recoverable: sourceRecoverable,
    });
  }
  if (cappedCells > 0) {
    sourceTruncations.push({
      technique: 'db-cell-cap',
      inputSize: inputChars,
      outputSize: outputChars,
      unit: 'chars',
      recoverable,
    });
  }
  return {
    content,
    ...(sourceTruncations.length > 0 ? { sourceTruncations } : {}),
  };
}

export function defaultSchemaFromOptions(optionsJson: unknown): string | undefined {
  if (typeof optionsJson !== 'string' || !optionsJson) return undefined;
  try {
    const parsed = JSON.parse(optionsJson) as { defaultSchema?: unknown };
    return typeof parsed.defaultSchema === 'string' && parsed.defaultSchema.trim()
      ? parsed.defaultSchema.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function schemaPageLimit(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : DEFAULT_SCHEMA_PAGE_SIZE;
  return Math.max(1, Math.min(parsed, MAX_SCHEMA_PAGE_SIZE));
}

function schemaPageOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Progressive schema inspection: list cheaply, expand exactly one table. */
export async function inspectRelationalSchemaResult(
  driver: DatabaseDriver,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const schema = typeof args.schema === 'string' && args.schema.trim() ? args.schema.trim() : undefined;
  // Drivers without cancellable metadata APIs may finish in the background.
  // Stop awaiting them, ignore their late result, and never start a second read.
  const refs = await abortableRead(() => driver.listTables(schema), signal);
  signal?.throwIfAborted();
  const tableName = typeof args.table === 'string' && args.table.trim() ? args.table.trim() : undefined;
  if (tableName) {
    const ref = refs.find((table) => table.name === tableName)
      ?? refs.find((table) => table.name.toLocaleLowerCase() === tableName.toLocaleLowerCase());
    if (!ref) {
      throw new Error(`table '${tableName}' not found in the selected schema; use db_schema search to locate it`);
    }
    return ok(renderSchema([await abortableRead(() => driver.describeTable(ref.schema, ref.name), signal)]));
  }

  const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined;
  const searchLower = search?.toLocaleLowerCase();
  const filtered: TableRef[] = searchLower
    ? refs.filter((table) => `${table.schema}.${table.name}`.toLocaleLowerCase().includes(searchLower))
    : refs;
  const offset = schemaPageOffset(args.offset);
  const limit = schemaPageLimit(args.limit);
  const page = filtered.slice(offset, offset + limit);
  const content = renderSchemaCatalog(page, {
    total: filtered.length,
    offset,
    limit,
    search,
  });
  const omitted = filtered.length > 0 && (offset > 0 || page.length < filtered.length);
  return {
    content,
    ...(omitted
      ? {
          sourceTruncations: [{
            technique: 'db-schema-page',
            inputSize: filtered.length,
            outputSize: page.length,
            unit: 'items' as const,
            recoverable: true,
          }],
        }
      : {}),
  };
}

/** Backwards-compatible string view used by direct callers/tests. */
export async function inspectRelationalSchema(
  driver: DatabaseDriver,
  args: Record<string, unknown>,
): Promise<string> {
  return (await inspectRelationalSchemaResult(driver, args)).content;
}

const dbList: CoderTool = {
  name: 'db_list',
  effectBoundary: 'database', mutates: false, parallelSafe: false,
  description:
    'List the database connections registered in the Databases tab: name, engine, host/file, ' +
    'database, read-only flag and kind (relational/document/keyvalue). Never returns ' +
    'credentials and does NOT connect. Call this before db_query/db_schema/db_command when ' +
    'unsure which connection to target.',
  source: 'native',
  outputPolicy: { mode: 'structured', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
  riskLevel: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx): Promise<ToolResult> => {
    if (ctx.ports?.database) databaseInvocation(ctx, 'list', undefined).assertDispatch();
    const scoped = resolveToolScope(ctx);
    if (!scoped.ok) return err(scoped.error);
    if (scoped.scope.length === 0) {
      return ok('(no database connections registered — ask the user to add one in the Databases tab)');
    }
    const lines = scoped.scope.map(({ name, conn }) => {
      const target = conn.engine === 'sqlite' ? (conn.file_path ?? '-') : (conn.host ?? '-');
      const db = conn.database_name ? ` db=${conn.database_name}` : '';
      const ro = conn.is_read_only === 1 ? ' [read-only]' : '';
      return `- ${name} (${conn.engine}, ${engineKind(conn.engine)}${ro}) target=${target}${db}`;
    });
    return ok(lines.join('\n'));
  },
};

const dbSchema: CoderTool = {
  name: 'db_schema',
  effectBoundary: 'database', mutates: false, parallelSafe: false,
  description:
    'Progressively inspect a relational database without flooding context. With no `table`, ' +
    'returns a compact paginated catalog of table/view names only (default 40, max 100); use ' +
    '`search` to narrow. Pass exactly one `table` to fetch its columns, nullability and PK flags. ' +
    '`schema` defaults to the connection filter or the engine default. Never try to load every table definition at once.',
  source: 'native',
  outputPolicy: { mode: 'structured', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      connection: CONNECTION_PARAM,
      schema: { type: 'string', description: 'Schema / database name (defaults per engine).' },
      table: { type: 'string', description: 'One exact table/view name to expand with columns and keys.' },
      search: { type: 'string', description: 'Case-insensitive substring filter for the compact catalog.' },
      offset: { type: 'number', description: 'Catalog offset for pagination (default 0).' },
      limit: { type: 'number', description: 'Catalog page size (default 40, max 100).' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const picked = pickFromCtx(ctx, args.connection);
    if (!picked.ok) return err(picked.error);
    const signal = asAbortSignal(ctx.signal);
    let acquired = null as Awaited<ReturnType<typeof acquireAgentDriver>> | null;
    try {
      acquired = await abortableRead(() => acquireToolDriver(picked.value.conn, ctx, 'schema', args.connection), signal);
      signal?.throwIfAborted();
      if ((acquired.meta.kind ?? 'relational') !== 'relational') {
        return err(`db_schema targets relational engines; use db_command for ${acquired.meta.kind} stores.`);
      }
      const savedSchema = defaultSchemaFromOptions(picked.value.conn.options_json);
      const inspectionArgs = typeof args.schema === 'string' && args.schema.trim()
        ? args
        : { ...args, schema: savedSchema };
      return await inspectRelationalSchemaResult(acquired.driver, inspectionArgs, signal);
    } catch (e) {
      if (signal?.aborted) return err('db_schema cancelled.', {
        code: 'DB_SCHEMA_CANCELLED', kind: 'cancelled', retryable: false,
      });
      return err(`db_schema failed: ${scrubDbError(e, acquired?.spec)}`);
    }
  },
};

const dbQuery: CoderTool = {
  name: 'db_query',
  mutates: true, parallelSafe: false, riskLevel: 'write',
  effectBoundary: 'database',
  description:
    'Execute ONE SQL statement against a registered relational connection. Reads AND writes ' +
    'are allowed unless the connection is marked read-only in the Databases tab. Use `params` ' +
    'for values derived from user/agent input (Postgres $1…, MySQL ?). Results are capped — ' +
    'paginate with LIMIT/OFFSET. Pass `connection` when more than one is registered.',
  source: 'native',
  outputPolicy: { mode: 'rows', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
  riskOf: (input) => {
    const sql = (input as { sql?: unknown } | null)?.sql;
    return typeof sql === 'string' && isReadStatement(sql) ? 'read' : 'write';
  },
  parameters: {
    type: 'object',
    properties: {
      connection: CONNECTION_PARAM,
      sql: { type: 'string', description: 'A single SQL statement to execute.' },
      params: { type: 'array', description: 'Positional parameters for the statement.', items: {} },
      max_rows: { type: 'number', description: 'Row cap (default 200, max 1000).' },
    },
    required: ['sql'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const sql = typeof args.sql === 'string' ? args.sql : '';
    if (!sql.trim()) return err('db_query: sql (non-empty string) required');
    if (hasMultipleStatements(sql)) {
      return err('db_query: multiple statements are not allowed — send ONE statement per call.');
    }
    const picked = pickFromCtx(ctx, args.connection);
    if (!picked.ok) return err(picked.error);
    let acquired = null as Awaited<ReturnType<typeof acquireAgentDriver>> | null;
    const signal = combinedMutationSignal(ctx.signal, ctx.mutationFence);
    const mutates = !isReadStatement(sql);
    const operation = sql.trim().match(/^([a-z]+)/i)?.[1]?.toLowerCase() ?? 'unknown';
    let dispatched = false;
    try {
      acquired = await abortableRead(() => acquireToolDriver(picked.value.conn, ctx, operation, args.connection), signal);
      if ((acquired.meta.kind ?? 'relational') !== 'relational') {
        return err(
          `db_query targets relational engines — '${picked.value.name}' is a ` +
            `${acquired.meta.kind} store. Use db_command instead.`,
        );
      }
      if (acquired.meta.readOnly && !isReadStatement(sql)) {
        return err('Connection is read-only — writes are blocked.');
      }
      const params = Array.isArray(args.params) ? (args.params as unknown[]) : undefined;
      const beforeDispatch = () => {
        signal?.throwIfAborted();
        if (mutates) assertMutationFence(ctx.mutationFence, {
          kind: 'database',
          operation,
          resource: String(args.connection ?? '<default>'),
        });
      };
      beforeDispatch();
      const driver = acquired.driver;
      const result = await cancellableToolRpc(() => {
        dispatched = true;
        return driver.runQuery(sql, { params, maxRows: clampMaxRows(args.max_rows), signal, beforeDispatch });
      }, () => { /* Driver cancellation consumes signal; failure after dispatch is uncertain. */ }, signal, 'Database query cancelled.');
      return renderDbResult(result, ctx, isReadStatement(sql));
    } catch (e) {
      if (dispatched && mutates) {
        ctx.ports?.database?.outcomeUnknown();
        return unknownToolOutcome(`db_query completion is unconfirmed: ${scrubDbError(e, acquired?.spec)}. Reconcile before retrying.`);
      }
      if (signal?.aborted) return err('db_query cancelled.', { code: 'DB_QUERY_CANCELLED', kind: 'cancelled', retryable: false });
      return err(`db_query failed: ${scrubDbError(e, acquired?.spec)}`);
    }
  },
};

/** Best-effort read/write classification with no engine at hand (gate hook). */
function commandRisk(input: unknown): 'read' | 'write' {
  const c = (input as { command?: unknown } | null)?.command;
  if (!c || typeof c !== 'object') return 'write';
  // A mixed command can be read-safe for Mongo and mutating for Redis (or
  // vice versa). The gate cannot choose the eventual connection's engine.
  if ('op' in c && 'args' in c) return 'write';
  const probe = c as Omit<DbCommand, 'kind'>;
  const asDocument = isWriteCommand({ ...probe, kind: 'document' });
  const asKeyvalue = isWriteCommand({ ...probe, kind: 'keyvalue' });
  // Read only when at least one engine interpretation proves it read-safe;
  // unknown ops classify as write under both (conservative).
  return asDocument && asKeyvalue ? 'write' : 'read';
}

const dbCommand: CoderTool = {
  name: 'db_command',
  mutates: true, parallelSafe: false, riskLevel: 'write',
  effectBoundary: 'database',
  description:
    'Run a document/key-value command on a MongoDB or Redis connection (relational engines ' +
    'must use db_query). Shape: {op, collection?, payload?} for Mongo ' +
    "(find/aggregate/insertOne/…, payload carries filter/pipeline/document) or {args: ['GET','key']} " +
    'for Redis. Read-only connections refuse mutating commands.',
  source: 'native',
  outputPolicy: { mode: 'rows', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
  riskOf: commandRisk,
  parameters: {
    type: 'object',
    properties: {
      connection: CONNECTION_PARAM,
      command: {
        type: 'object',
        description: 'The command: {op?, collection?, args?, payload?} (engine-specific).',
        properties: {
          op: { type: 'string', description: 'Mongo operation (find/aggregate/insertOne/…).' },
          collection: { type: 'string', description: 'Mongo target collection.' },
          args: { type: 'array', items: { type: 'string' }, description: "Redis command+args, e.g. ['GET','key']." },
          payload: { description: 'Operation payload (filter/pipeline/document/value/…).' },
        },
        additionalProperties: false,
      },
      max_rows: { type: 'number', description: 'Row/document cap (default 200, max 1000).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const raw = args.command;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return err('db_command: command (object) required — see the tool description for its shape.');
    }
    const picked = pickFromCtx(ctx, args.connection);
    if (!picked.ok) return err(picked.error);
    let acquired = null as Awaited<ReturnType<typeof acquireAgentDriver>> | null;
    const signal = combinedMutationSignal(ctx.signal, ctx.mutationFence);
    let mutates = true;
    let dispatched = false;
    const inputCommand = raw as DbCommand;
    const operation = typeof inputCommand.op === 'string' ? inputCommand.op.toLowerCase()
      : String(inputCommand.args?.[0] ?? 'unknown').toLowerCase();
    try {
      acquired = await abortableRead(() => acquireToolDriver(picked.value.conn, ctx, operation, args.connection), signal);
      const kind = acquired.meta.kind ?? 'relational';
      if (kind === 'relational') {
        return err(
          `db_command is only for document/key-value stores — '${picked.value.name}' is ` +
            'relational. Use db_query instead.',
        );
      }
      const command: DbCommand = { ...(raw as Omit<DbCommand, 'kind'>), kind };
      if (acquired.meta.readOnly && isWriteCommand(command)) {
        return err('Connection is read-only — writes are blocked.');
      }
      if (!acquired.driver.runCommand) {
        return err(`db_command: the '${picked.value.conn.engine}' driver does not support commands.`);
      }
      mutates = isWriteCommand(command);
      const beforeDispatch = () => {
        signal?.throwIfAborted();
        if (mutates) assertMutationFence(ctx.mutationFence, {
          kind: 'database',
          operation,
          resource: String(args.connection ?? '<default>'),
        });
      };
      beforeDispatch();
      const driver = acquired.driver;
      const result = await cancellableToolRpc(() => {
        dispatched = true;
        return driver.runCommand!(command, { maxRows: clampMaxRows(args.max_rows), signal, beforeDispatch });
      }, () => { /* Driver cancellation consumes signal; it does not prove rollback. */ }, signal, 'Database command cancelled.');
      return renderDbResult(result, ctx, !mutates);
    } catch (e) {
      if (dispatched && mutates) {
        ctx.ports?.database?.outcomeUnknown();
        return unknownToolOutcome(`db_command completion is unconfirmed: ${scrubDbError(e, acquired?.spec)}. Reconcile before retrying.`);
      }
      if (signal?.aborted) return err('db_command cancelled.', { code: 'DB_COMMAND_CANCELLED', kind: 'cancelled', retryable: false });
      return err(`db_command failed: ${scrubDbError(e, acquired?.spec)}`);
    }
  },
};

export const dbTools: CoderTool[] = [dbList, dbSchema, dbQuery, dbCommand];
