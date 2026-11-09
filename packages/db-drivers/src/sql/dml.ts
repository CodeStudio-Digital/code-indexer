/**
 * Row-edit (DML) builders. Each returns BOTH a parameterized statement (`sql` +
 * `params`, used for safe execution) and a `display` rendering with literals
 * inlined (used for the preview dialog only). Update/Delete are PK-targeted.
 */
import { placeholder, quoteIdent, quoteRelation, renderLiteral } from './identifiers.js';
import type { DbEngine } from '../types.js';

export type RowChangeKind = 'insert' | 'update' | 'delete';

export interface RowChange {
  op: RowChangeKind;
  schema?: string;
  table: string;
  /** PK column → value, required for update/delete. */
  pk?: Record<string, unknown>;
  /** Column → new value, for insert/update. */
  values?: Record<string, unknown>;
  /** Values observed when the row was loaded. Compared atomically with the PK. */
  original?: Record<string, unknown>;
}

export interface BuiltDml {
  sql: string;
  params: unknown[];
  display: string;
}

export function buildDml(engine: DbEngine, change: RowChange): BuiltDml {
  let built: BuiltDml;
  switch (change.op) {
    case 'insert':
      return buildInsert(engine, change);
    case 'update':
      built = buildUpdate(engine, change); break;
    case 'delete':
      built = buildDelete(engine, change); break;
  }
  if (change.original) {
    for (const [column, value] of Object.entries(change.original)) {
      if (value !== null && typeof value === 'object') throw new Error('Optimistic editing requires comparable scalar original values. Use an explicit SQL transaction for complex cells.');
      const name = quoteIdent(engine, column);
      const predicate = value == null ? `${name} IS NULL` : `${name} = ${placeholder(engine, built.params.length)}`;
      built.sql += ` AND ${predicate}`;
      built.display += ` AND ${value == null ? `${name} IS NULL` : `${name} = ${renderLiteral(value)}`}`;
      if (value != null) built.params.push(value);
    }
  }
  return built;
}

function buildInsert(engine: DbEngine, change: RowChange): BuiltDml {
  const rel = quoteRelation(engine, change.schema, change.table);
  const entries = Object.entries(change.values ?? {});
  if (entries.length === 0) throw new Error('insertRow: no values');
  const cols = entries.map(([c]) => quoteIdent(engine, c)).join(', ');
  const params = entries.map(([, v]) => v);
  const phs = entries.map((_, i) => placeholder(engine, i)).join(', ');
  const sql = `INSERT INTO ${rel} (${cols}) VALUES (${phs})`;
  const display = `INSERT INTO ${rel} (${cols}) VALUES (${entries.map(([, v]) => renderLiteral(v)).join(', ')})`;
  return { sql, params, display };
}

function buildUpdate(engine: DbEngine, change: RowChange): BuiltDml {
  const rel = quoteRelation(engine, change.schema, change.table);
  const setEntries = Object.entries(change.values ?? {});
  const pkEntries = Object.entries(change.pk ?? {});
  if (setEntries.length === 0) throw new Error('updateRow: no values');
  if (pkEntries.length === 0) throw new Error('updateRow: no primary key — refusing an unscoped UPDATE');
  const params: unknown[] = [];
  let i = 0;
  const setClause = setEntries
    .map(([c, v]) => {
      params.push(v);
      return `${quoteIdent(engine, c)} = ${placeholder(engine, i++)}`;
    })
    .join(', ');
  const whereClause = pkEntries
    .map(([c, v]) => {
      params.push(v);
      return `${quoteIdent(engine, c)} = ${placeholder(engine, i++)}`;
    })
    .join(' AND ');
  const sql = `UPDATE ${rel} SET ${setClause} WHERE ${whereClause}`;
  const displaySet = setEntries.map(([c, v]) => `${quoteIdent(engine, c)} = ${renderLiteral(v)}`).join(', ');
  const displayWhere = pkEntries.map(([c, v]) => `${quoteIdent(engine, c)} = ${renderLiteral(v)}`).join(' AND ');
  return { sql, params, display: `UPDATE ${rel} SET ${displaySet} WHERE ${displayWhere}` };
}

function buildDelete(engine: DbEngine, change: RowChange): BuiltDml {
  const rel = quoteRelation(engine, change.schema, change.table);
  const pkEntries = Object.entries(change.pk ?? {});
  if (pkEntries.length === 0) throw new Error('deleteRow: no primary key — refusing an unscoped DELETE');
  const params: unknown[] = [];
  const whereClause = pkEntries
    .map(([c, v], i) => {
      params.push(v);
      return `${quoteIdent(engine, c)} = ${placeholder(engine, i)}`;
    })
    .join(' AND ');
  const display = pkEntries.map(([c, v]) => `${quoteIdent(engine, c)} = ${renderLiteral(v)}`).join(' AND ');
  return { sql: `DELETE FROM ${rel} WHERE ${whereClause}`, params, display: `DELETE FROM ${rel} WHERE ${display}` };
}
