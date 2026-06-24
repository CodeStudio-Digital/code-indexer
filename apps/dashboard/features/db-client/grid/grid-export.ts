/**
 * Pure serializers for exporting/copying result rows — CSV, JSON, TSV (clipboard)
 * and INSERT statements. No DOM, no engine dep, so they're trivially testable.
 */
type Row = Record<string, unknown>;

function asText(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function csvCell(v: unknown): string {
  const s = asText(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Row[]): string {
  const head = columns.map(csvCell).join(',');
  if (rows.length === 0) return head;
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\n');
  return `${head}\n${body}`;
}

export function toJson(columns: string[], rows: Row[]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))),
    null,
    2,
  );
}

/** Tab-separated (for clipboard — paste into a spreadsheet/editor). Tabs/newlines collapsed. */
export function toTsv(columns: string[], rows: Row[]): string {
  const clean = (v: unknown): string => asText(v).replace(/[\t\r\n]+/g, ' ');
  const head = columns.map(clean).join('\t');
  if (rows.length === 0) return head;
  return `${head}\n${rows.map((r) => columns.map((c) => clean(r[c])).join('\t')).join('\n')}`;
}

function sqlLiteral(v: unknown): string {
  if (v == null) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${asText(v).replace(/'/g, "''")}'`;
}

/** ANSI-style INSERT statements (double-quoted idents). Good enough for export/copy. */
export function toInsertSql(table: string, columns: string[], rows: Row[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const cols = columns.map(q).join(', ');
  return rows
    .map((r) => `INSERT INTO ${q(table)} (${cols}) VALUES (${columns.map((c) => sqlLiteral(r[c])).join(', ')});`)
    .join('\n');
}

/** Single cell as a copyable string (NULL → empty). */
export function cellToCopy(v: unknown): string {
  return asText(v);
}
