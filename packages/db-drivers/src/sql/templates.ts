import type { DbEngine } from '../types.js';

/** Build a bounded SELECT template using the target engine's row-limit syntax. */
export function buildSelectTemplate(engine: DbEngine, relation: string, limit = 100): string {
  const rowLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 100;
  if (engine === 'mssql') return `SELECT TOP (${rowLimit}) * FROM ${relation};`;
  if (engine === 'oracle') return `SELECT * FROM ${relation} FETCH FIRST ${rowLimit} ROWS ONLY;`;
  return `SELECT * FROM ${relation} LIMIT ${rowLimit};`;
}

/** Build an engine-correct, non-analyzing EXPLAIN statement. */
export function buildExplainStatement(engine: DbEngine, sql: string): string | null {
  // SQL Server SHOWPLAN is a session toggle and must not leak through a pool.
  if (engine === 'mssql') return null;
  if (engine === 'sqlite') return `EXPLAIN QUERY PLAN ${sql}`;
  if (engine === 'oracle') return `EXPLAIN PLAN FOR ${sql}`;
  return `EXPLAIN ${sql}`;
}

/** Default schema used when a table operation did not carry one explicitly. */
export function defaultSchemaFor(engine: DbEngine): string | undefined {
  if (engine === 'postgres') return 'public';
  if (engine === 'mssql') return 'dbo';
  return undefined;
}
