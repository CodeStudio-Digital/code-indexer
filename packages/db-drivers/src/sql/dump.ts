/**
 * Pure serializer for a `.sql` dump — INSERT statements with INLINE literals
 * (not parameterized, unlike buildDml), engine-aware identifier quoting reused
 * from identifiers.ts. No DB, no native module → trivially testable. The handler
 * streams these per page so a huge table never lands in memory whole.
 */
import type { DbEngine } from '../types.js';
import { quoteIdent, quoteRelation } from './identifiers.js';

/** Render one value as an inline SQL literal, dialect-aware. */
function literal(engine: DbEngine, v: unknown): string {
  if (v == null) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  // SQL Server + Oracle have no boolean literal — they store bit/NUMBER 0/1.
  if (typeof v === 'boolean') {
    if (engine === 'mssql' || engine === 'oracle') return v ? '1' : '0';
    return v ? 'TRUE' : 'FALSE';
  }
  if (v instanceof Date) return quote(engine, v.toISOString());
  return quote(engine, typeof v === 'object' ? JSON.stringify(v) : String(v));
}

/** Quote a string literal, escaping per dialect (MySQL/MariaDB also treat backslash as an escape). */
function quote(engine: DbEngine, s: string): string {
  const escaped = engine === 'mysql' || engine === 'mariadb'
    ? s.replace(/\\/g, '\\\\').replace(/'/g, "''")
    : s.replace(/'/g, "''");
  return `'${escaped}'`;
}

/**
 * INSERT statements (one per row) for a schema-qualified table. Returns '' when
 * there are no rows so the caller can skip the chunk.
 */
export function insertLiteral(
  engine: DbEngine,
  schema: string | undefined,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string {
  if (rows.length === 0) return '';
  const rel = quoteRelation(engine, schema, table);
  const cols = columns.map((c) => quoteIdent(engine, c)).join(', ');
  return rows
    .map((r) => `INSERT INTO ${rel} (${cols}) VALUES (${columns.map((c) => literal(engine, r[c])).join(', ')});`)
    .join('\n');
}
