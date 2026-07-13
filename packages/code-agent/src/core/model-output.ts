import type { ToolResult } from '@mcp/code-agent/core/tool.js';

export interface MarkdownTableColumn<T extends Record<string, unknown>> {
  key: keyof T & string;
  label?: string;
  value?: (row: T) => unknown;
}

function compactJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

function prettyJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

function isScalar(value: unknown): boolean {
  return value == null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
}

export function markdownEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_TOOL_RESULT_MARKDOWN !== '0';
}

export function markdownCell(value: unknown): string {
  if (value == null) return 'null';
  const text = isScalar(value) ? String(value) : compactJson(value);
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_~\[\]<>])/g, '\\$1')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

export function markdownTable<T extends Record<string, unknown>>(
  rows: readonly T[],
  columns?: readonly MarkdownTableColumn<T>[],
): string {
  if (rows.length === 0) return '(none)';
  const inferred = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cols: readonly MarkdownTableColumn<T>[] = columns?.length
    ? columns
    : inferred.map((key) => ({ key: key as keyof T & string }));
  const header = cols.map((column) => column.label ?? column.key).join(' | ');
  const separator = cols.map(() => '---').join(' | ');
  const body = rows.map((row) => cols
    .map((column) => markdownCell(column.value ? column.value(row) : row[column.key]))
    .join(' | '));
  return [header, separator, ...body].join('\n');
}

export function markdownList(values: readonly unknown[]): string {
  return values.length === 0 ? '(none)' : values.map((value) => `- ${markdownCell(value)}`).join('\n');
}

export function markdownCode(value: string, language = ''): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function canRenderTable(rows: unknown[]): rows is Array<Record<string, unknown>> {
  if (rows.length === 0 || rows.length > 500) return false;
  if (!rows.every((row) => row != null && typeof row === 'object' && !Array.isArray(row))) return false;
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row as Record<string, unknown>)))];
  return keys.length > 0
    && keys.length <= 12
    && rows.every((row) => keys.every((key) => isScalar((row as Record<string, unknown>)[key])));
}

function heading(depth: number, label: string): string {
  return `${'#'.repeat(Math.min(6, Math.max(2, depth)))} ${markdownCell(label)}`;
}

function renderValue(value: unknown, depth: number): string {
  if (isScalar(value)) return markdownCell(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    if (canRenderTable(value)) return markdownTable(value);
    if (value.every(isScalar)) return markdownList(value);
    return value.map((item, index) => {
      if (isScalar(item)) return `- ${markdownCell(item)}`;
      return `${heading(depth, `Item ${index + 1}`)}\n${renderValue(item, depth + 1)}`;
    }).join('\n\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '(none)';
  const scalarLines = entries
    .filter(([, item]) => isScalar(item))
    .map(([key, item]) => `- ${key}: ${markdownCell(item)}`);
  const nested = entries
    .filter(([, item]) => !isScalar(item))
    .map(([key, item]) => `${heading(depth, key)}\n${renderValue(item, depth + 1)}`);
  return [...scalarLines, ...nested].join('\n\n');
}

/** Deterministic generic projection. Domain-specific renderers may compose its primitives. */
export function renderStructuredMarkdown(value: unknown, title?: string): string {
  const body = renderValue(value, title ? 2 : 1);
  return title ? `# ${title}\n\n${body}` : body;
}

export function structuredChars(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : encoded.length;
  } catch {
    return null;
  }
}

export function structuredResult(
  data: unknown,
  markdown: string,
  opts: { error?: boolean; env?: NodeJS.ProcessEnv } = {},
): ToolResult {
  const useMarkdown = markdownEnabled(opts.env);
  return {
    content: useMarkdown ? markdown : prettyJson(data),
    contentFormat: useMarkdown ? 'markdown' : 'json',
    structuredData: data,
    ...(opts.error ? { isError: true } : {}),
  };
}

export function okStructured(data: unknown, markdown = renderStructuredMarkdown(data)): ToolResult {
  return structuredResult(data, markdown);
}

export function errStructured(data: unknown, markdown = renderStructuredMarkdown(data)): ToolResult {
  return structuredResult(data, markdown, { error: true });
}
