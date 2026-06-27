/**
 * Engine-aware SQL helpers shared by the DML/DDL builders.
 *
 *  - `quoteIdent` quotes a table/column name with the engine's identifier
 *    quoting (pg/sqlite double-quote, mysql backtick), escaping embedded quotes.
 *  - `placeholder` returns the engine's positional bind marker.
 *  - `renderLiteral` renders a value as a SQL literal for the (display-only)
 *    preview — NEVER used for execution (execution always binds parameters).
 */
import type { DbEngine, TableSort } from '../types.js';

export function quoteIdent(engine: DbEngine, name: string): string {
  if (engine === 'mysql' || engine === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
  if (engine === 'mssql') return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Qualified `schema.table` (or just `table` when schema is absent/sqlite-main). */
export function quoteRelation(engine: DbEngine, schema: string | undefined, table: string): string {
  const t = quoteIdent(engine, table);
  if (!schema || (engine === 'sqlite' && schema === 'main')) return t;
  return `${quoteIdent(engine, schema)}.${t}`;
}

/** Positional bind marker: Postgres `$1,$2…`; SQL Server `@p0,@p1…`; Oracle `:1,:2…`; MySQL/SQLite `?`. */
export function placeholder(engine: DbEngine, index: number): string {
  if (engine === 'postgres') return `$${index + 1}`;
  if (engine === 'mssql') return `@p${index}`;
  if (engine === 'oracle') return `:${index + 1}`;
  return '?';
}

/**
 * Sort expression `"col" ASC|DESC` for a table preview, or null when no sort.
 * The column is identifier-quoted and the direction is a closed enum, so a
 * column name from the UI can't inject SQL.
 */
export function orderBySql(engine: DbEngine, orderBy: TableSort | undefined): string | null {
  if (!orderBy?.column) return null;
  const dir = orderBy.dir === 'desc' ? 'DESC' : 'ASC';
  return `${quoteIdent(engine, orderBy.column)} ${dir}`;
}

/** Render a JS value as a SQL literal — DISPLAY/preview ONLY. */
export function renderLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}
