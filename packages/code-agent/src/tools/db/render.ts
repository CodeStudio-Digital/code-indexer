/**
 * PURE result rendering for the `db_*` tools — QueryResult/TableInfo →
 * markdown-ish text with a row cap so a `SELECT *` on a big table can't flood
 * the transcript. Character shaping belongs to the runner: it can persist the
 * complete rendered page before reducing it, whereas a renderer-level slice
 * permanently destroys cells and often the pagination footer.
 */
import type { QueryResult, TableInfo, TableRef } from '@mcp/db-drivers/types.js';
import { stripUnpairedSurrogates } from '@mcp/code-agent/core/text-boundaries.js';

export const MAX_RENDER_CELL_CHARS = 1_000_000;

export interface QueryRenderOptions {
  maxCellChars?: number;
  outputStore?: { put(content: string): string | null };
  onCellTruncated?: (info: {
    inputChars: number;
    outputChars: number;
    recoverable: boolean;
  }) => void;
}

export interface SchemaCatalogMeta {
  total: number;
  offset: number;
  limit: number;
  search?: string;
}

export function stringifyCell(v: unknown, options: QueryRenderOptions = {}): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  let rendered: string;
  if (typeof v === 'object') {
    try {
      rendered = JSON.stringify(v);
    } catch {
      rendered = String(v);
    }
  } else {
    rendered = String(v);
  }
  // One physical line must equal one logical row: the smart reducer and the
  // machine-checkable footer both rely on this boundary. Escaping pipes also
  // keeps a cell from inventing extra markdown columns.
  const escaped = rendered
    .replace(/\r\n?|\n/g, '\\n')
    .replace(/\|/g, '\\|');
  const rawCap = options.maxCellChars ?? MAX_RENDER_CELL_CHARS;
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? Math.max(1, Math.floor(rawCap)) : MAX_RENDER_CELL_CHARS;
  if (escaped.length <= cap) return escaped;
  const outputId = options.outputStore?.put(rendered) ?? undefined;
  const marker = outputId
    ? `[cell truncated: output_id=${outputId}; original_size=${rendered.length}; use get_tool_output]`
    : `[cell truncated: original_size=${rendered.length}; output store unavailable]`;
  if (marker.length >= cap) {
    const output = marker.slice(0, cap);
    options.onCellTruncated?.({
      inputChars: escaped.length,
      outputChars: output.length,
      recoverable: !!outputId,
    });
    return output;
  }
  const room = cap - marker.length;
  const head = Math.ceil(room * 0.55);
  const tail = Math.max(0, room - head);
  const output = stripUnpairedSurrogates(
    escaped.slice(0, head) + marker + (tail > 0 ? escaped.slice(-tail) : ''),
  );
  options.onCellTruncated?.({
    inputChars: escaped.length,
    outputChars: output.length,
    recoverable: !!outputId,
  });
  return output;
}

/**
 * Render a QueryResult as a markdown table with a machine-checkable footer:
 * `rows=<returned> truncated=<bool>`. Row acquisition is bounded by the
 * driver/tool `max_rows` contract. Once materialized, every row is rendered so
 * the central runner can persist the exact page before model-aware reduction.
 */
export function renderQueryResult(result: QueryResult, options: QueryRenderOptions = {}): string {
  if (result.rows.length === 0) {
    const verb = result.command ? ` (${result.command})` : '';
    return `OK${verb} — ${result.rowCount} row(s) affected.\nrows=0 truncated=false`;
  }
  const columnNames =
    result.fields.length > 0 ? result.fields.map((f) => f.name) : Object.keys(result.rows[0]);
  const renderRows = result.rows;
  const truncated = result.truncated === true;
  const header = columnNames.join(' | ');
  const sep = columnNames.map(() => '---').join(' | ');
  const body = renderRows
    .map((row) => columnNames.map((name) => stringifyCell(row[name], options)).join(' | '))
    .join('\n');
  const footer = `rows=${renderRows.length} truncated=${truncated}`;
  const hint = truncated
    ? '\n[result truncated — narrow with WHERE, or paginate with LIMIT/OFFSET]'
    : '';
  return `${header}\n${sep}\n${body}\n${footer}${hint}`;
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
  return body;
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
  const page = `page offset=${meta.offset} returned=${tables.length} total=${meta.total} more=${more}`
    + (more ? ` next_offset=${end}` : '');
  const hint = more
    ? 'Do not page through the whole catalog. Use search:"term" to narrow, then table:"name" for columns/keys; use next_offset only when the current page is genuinely insufficient.'
    : 'Use search:"term" to narrow or table:"name" for columns/keys.';
  return `SCHEMA CATALOG\n${lines.join('\n')}\n${page}\n[progressive inspection: ${hint}]`;
}
