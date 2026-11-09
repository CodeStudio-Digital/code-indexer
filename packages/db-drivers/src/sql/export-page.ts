import { placeholder, quoteIdent, quoteRelation } from './identifiers.js';
import type { DbEngine } from '../types.js';

/** Lexicographic keyset across the complete primary key, including mixed values. */
export function buildExportPage(engine: DbEngine, schema: string | undefined, table: string, keys: string[], after: unknown[] | undefined, limit: number) {
  if (!keys.length) throw new Error('A primary key is required for resumable export. Use a native snapshot dump for a table without a primary key.');
  if (after && (after.length !== keys.length || after.some(v => v == null))) throw new Error('Export checkpoint does not contain the complete non-null primary key.');
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return placeholder(engine, params.length - 1); };
  const where = after ? keys.map((key, index) => '(' + [
    ...keys.slice(0, index).map((k, i) => `${quoteIdent(engine, k)} = ${bind(after[i])}`),
    `${quoteIdent(engine, key)} > ${bind(after[index])}`,
  ].join(' AND ') + ')').join(' OR ') : '';
  const take = Math.max(1, Math.min(1000, Math.floor(limit) || 500)) + 1;
  const top = engine === 'mssql' ? `TOP (${take}) ` : '';
  const tail = engine === 'oracle' ? ` FETCH FIRST ${take} ROWS ONLY` : engine === 'mssql' ? '' : ` LIMIT ${take}`;
  return { sql: `SELECT ${top}* FROM ${quoteRelation(engine, schema, table)}${where ? ` WHERE ${where}` : ''} ORDER BY ${keys.map(k => quoteIdent(engine, k)).join(', ')}${tail}`, params, limit: take - 1 };
}
