export type DbQueryRisk = 'read' | 'write' | 'destructive' | 'review';

interface DbQueryInputView {
  connection: string;
  sql: string;
  params: unknown[];
  maxRows: number | null;
}

interface DbQueryAnalysis {
  operation: string;
  risk: DbQueryRisk;
  statementCount: number;
  lineCount: number;
  flaggedKeywords: string[];
  preview: string;
}

type DbQueryResultKind = 'markdown' | 'json' | 'text';

interface DbQueryResultView {
  kind: DbQueryResultKind;
  /** Content without the renderer metadata trailer, suitable for display. */
  body: string;
  /** Indented JSON, only present when the result is valid JSON. */
  pretty: string | null;
}

const READ_OPERATIONS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH']);
const WRITE_KEYWORDS = [
  'INSERT', 'UPDATE', 'MERGE', 'ALTER', 'CREATE', 'REPLACE', 'GRANT', 'REVOKE',
  'ATTACH', 'DETACH', 'VACUUM', 'REINDEX', 'CALL',
] as const;
const DESTRUCTIVE_KEYWORDS = ['DELETE', 'DROP', 'TRUNCATE'] as const;

/**
 * Mask comments and quoted values while preserving statement boundaries and
 * keywords. This powers display hints only; the backend remains authoritative
 * for permission and read-only enforcement.
 */
export function maskSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  let state: 'plain' | 'single' | 'double' | 'bracket' | 'line-comment' | 'block-comment' = 'plain';
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === 'plain') {
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '[') state = 'bracket';
      else if (ch === '-' && next === '-') { state = 'line-comment'; i += 1; }
      else if (ch === '/' && next === '*') { state = 'block-comment'; i += 1; }
      else out += ch;
    } else if (state === 'single') {
      if (ch === "'" && next === "'") i += 1;
      else if (ch === "'") state = 'plain';
      out += ch === '\n' ? '\n' : ' ';
    } else if (state === 'double') {
      if (ch === '"' && next === '"') i += 1;
      else if (ch === '"') state = 'plain';
      out += ch === '\n' ? '\n' : ' ';
    } else if (state === 'bracket') {
      if (ch === ']' && next === ']') i += 1;
      else if (ch === ']') state = 'plain';
      out += ch === '\n' ? '\n' : ' ';
    } else if (state === 'line-comment') {
      if (ch === '\n') { state = 'plain'; out += '\n'; }
      else out += ' ';
    } else {
      if (ch === '*' && next === '/') { state = 'plain'; out += '  '; i += 1; }
      else out += ch === '\n' ? '\n' : ' ';
    }
    i += 1;
  }
  return out;
}

export function parseDbQueryInput(input: Record<string, unknown> | undefined | null): DbQueryInputView {
  return {
    connection: typeof input?.connection === 'string' && input.connection.trim()
      ? input.connection.trim()
      : 'default',
    sql: typeof input?.sql === 'string' ? input.sql : '',
    params: Array.isArray(input?.params) ? input.params : [],
    maxRows: typeof input?.max_rows === 'number' && Number.isFinite(input.max_rows)
      ? input.max_rows
      : null,
  };
}

export function analyzeSqlForDisplay(sql: string): DbQueryAnalysis {
  const masked = maskSqlNoise(sql);
  const statements = masked.split(';').map((part) => part.trim()).filter(Boolean);
  const normalized = masked.replace(/\s+/g, ' ').trim();
  const first = /^([a-z_]+)/i.exec(normalized)?.[1]?.toUpperCase() ?? 'SQL';
  const flagged = new Set<string>();
  for (const keyword of [...DESTRUCTIVE_KEYWORDS, ...WRITE_KEYWORDS]) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(masked)) flagged.add(keyword);
  }
  if (/\bINTO\b/i.test(masked) && /\bSELECT\b/i.test(masked)) flagged.add('SELECT INTO');
  if (/\bNEXT\s+VALUE\s+FOR\b|\b(?:nextval|setval)\s*\(/i.test(masked)) flagged.add('SEQUENCE');

  const destructive = DESTRUCTIVE_KEYWORDS.some((keyword) => flagged.has(keyword));
  const writes = flagged.size > 0;
  const statementCount = Math.max(statements.length, sql.trim() ? 1 : 0);
  const risk: DbQueryRisk = destructive
    ? 'destructive'
    : writes
      ? 'write'
      : statementCount === 1 && READ_OPERATIONS.has(first)
        ? 'read'
        : 'review';
  return {
    operation: first,
    risk,
    statementCount,
    lineCount: sql ? sql.split(/\r?\n/).length : 0,
    flaggedKeywords: [...flagged],
    preview: sql.replace(/\s+/g, ' ').trim(),
  };
}

export function parseDbQueryResultMeta(content: string | undefined): { rows: number | null; truncated: boolean | null } {
  const match = /(?:^|\n)rows=(\d+)\s+truncated=(true|false)(?:\n|$)/i.exec(content ?? '');
  return match
    ? { rows: Number(match[1]), truncated: match[2].toLowerCase() === 'true' }
    : { rows: null, truncated: null };
}

/**
 * Classifies a database result without relying on its originating driver.
 * Query backends append `rows=… truncated=…` as a final metadata line; that
 * is useful in the card header but is not part of a Markdown or JSON payload.
 */
export function parseDbQueryResult(content: string | undefined): DbQueryResultView {
  const body = stripDbQueryResultMeta(content ?? '');
  const trimmed = body.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 0) {
    try {
      return { kind: 'json', body, pretty: JSON.stringify(JSON.parse(trimmed), null, 2) };
    } catch {
      // Invalid JSON remains plain text instead of showing a misleading pretty view.
    }
  }
  return {
    kind: looksLikeMarkdown(body) ? 'markdown' : 'text',
    body,
    pretty: null,
  };
}

function stripDbQueryResultMeta(content: string): string {
  const trailer = /(?:\r?\n)?rows=\d+\s+truncated=(?:true|false)\s*$/i.exec(content);
  return trailer ? content.slice(0, trailer.index).replace(/\r?\n$/, '') : content;
}

function looksLikeMarkdown(content: string): boolean {
  return (
    // GFM tables, such as the rows returned by the database tool.
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(content)
    || /(?:^|\n)```/.test(content)
    || /^\s{0,3}#{1,6}\s+\S/m.test(content)
    || /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s+)/m.test(content)
  );
}
