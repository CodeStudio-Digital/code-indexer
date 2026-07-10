/**
 * PURE result rendering for the `db_*` tools — QueryResult/TableInfo →
 * markdown-ish text with hard caps so a `SELECT *` on a big table can't flood
 * the transcript. Caps ported from the retired @mcp/company database-tools:
 * 50KB of chars, 500 rendered rows.
 */
import type { QueryResult, TableInfo, TableRef } from '@mcp/db-drivers/types.js';

export const MAX_RESULT_CHARS = 50_000;
export const MAX_RENDER_ROWS = 500;

export interface SchemaCatalogMeta {
  total: number;
  offset: number;
  limit: number;
  search?: string;
}

export function stringifyCell(v: unknown): string {
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

/** Char-level safety net applied after row-level capping. */
export function truncateText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[truncated — full result exceeded ${MAX_RESULT_CHARS} chars]`
  );
}

/**
 * Render a QueryResult as a markdown table with a machine-checkable footer:
 * `rows=<returned> truncated=<bool>`. When truncated (by the driver's maxRows
 * cap OR the render row cap) the footer suggests LIMIT/OFFSET pagination.
 */
export function renderQueryResult(result: QueryResult): string {
  if (result.rows.length === 0) {
    const verb = result.command ? ` (${result.command})` : '';
    return `OK${verb} — ${result.rowCount} row(s) affected.\nrows=0 truncated=false`;
  }
  const columnNames =
    result.fields.length > 0 ? result.fields.map((f) => f.name) : Object.keys(result.rows[0]);
  const renderRows = result.rows.slice(0, MAX_RENDER_ROWS);
  const elided = result.rows.length - renderRows.length;
  const truncated = result.truncated === true || elided > 0;
  const header = columnNames.join(' | ');
  const sep = columnNames.map(() => '---').join(' | ');
  const body = renderRows
    .map((row) => columnNames.map((name) => stringifyCell(row[name])).join(' | '))
    .join('\n');
  const footer = `rows=${renderRows.length} truncated=${truncated}`;
  const hint = truncated
    ? '\n[result truncated — narrow with WHERE, or paginate with LIMIT/OFFSET]'
    : '';
  return truncateText(`${header}\n${sep}\n${body}\n${footer}${hint}`);
}

/** Render db_schema output — one block per table (port of the old renderer). */
export function renderSchema(tables: TableInfo[]): string {
  if (tables.length === 0) {
    return '(no tables in schema — database is empty or the schema name is wrong)';
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
  return truncateText(body);
}

/**
 * Compact catalog page for progressive schema discovery. Deliberately omits
 * columns: `db_schema({table})` is the only path that expands a table, keeping
 * a 500-table database from consuming hundreds of introspection queries and a
 * full model context in one call.
 */
export function renderSchemaCatalog(tables: TableRef[], meta: SchemaCatalogMeta): string {
  if (tables.length === 0) {
    const qualifier = meta.search ? ` matching "${meta.search}"` : '';
    return `(no tables${qualifier} in this schema)`;
  }
  const end = meta.offset + tables.length;
  const more = end < meta.total;
  const lines = tables.map((table) => `- ${table.schema}.${table.name} [${table.kind}]`);
  const page = `page offset=${meta.offset} returned=${tables.length} total=${meta.total} more=${more}`;
  const next = more ? ` Next page: db_schema({offset:${end}, limit:${meta.limit}}).` : '';
  const hint = ' Pass table:"name" for columns/keys, or search:"term" to narrow.';
  return truncateText(`SCHEMA CATALOG\n${lines.join('\n')}\n${page}\n[progressive inspection.${next}${hint}]`);
}
