/**
 * Engine-aware SQL helpers shared by the DML/DDL builders.
 *
 *  - `quoteIdent` quotes a table/column name with the engine's identifier
 *    quoting (pg/sqlite double-quote, mysql backtick), escaping embedded quotes.
 *  - `placeholder` returns the engine's positional bind marker.
 *  - `renderLiteral` renders a value as a SQL literal for the (display-only)
 *    preview — NEVER used for execution (execution always binds parameters).
 */
import type { DbEngine } from '../types.js';

export function quoteIdent(engine: DbEngine, name: string): string {
  if (engine === 'mysql' || engine === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Qualified `schema.table` (or just `table` when schema is absent/sqlite-main). */
export function quoteRelation(engine: DbEngine, schema: string | undefined, table: string): string {
  const t = quoteIdent(engine, table);
  if (!schema || (engine === 'sqlite' && schema === 'main')) return t;
  return `${quoteIdent(engine, schema)}.${t}`;
}

/** Positional bind marker: Postgres uses `$1,$2…`; MySQL/SQLite use `?`. */
export function placeholder(engine: DbEngine, index: number): string {
  return engine === 'postgres' ? `$${index + 1}` : '?';
}

/** Render a JS value as a SQL literal — DISPLAY/preview ONLY. */
export function renderLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}
