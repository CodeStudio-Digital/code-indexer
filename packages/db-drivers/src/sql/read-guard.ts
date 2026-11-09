/**
 * Read-vs-write SQL classification — the read-only valve shared by the
 * embedded DB client handlers (`@mcp/api-handlers` dbClient) and the `db_*`
 * agent tools. Pure string analysis, no engine connection required.
 *
 * Moved verbatim from `packages/api-handlers/src/db-client/index.ts` so both
 * consumers guard with the SAME rules (one classifier, one failure direction).
 */

/** Lexical features that exist only in some SQL dialects. */
interface ScanMode {
  /** Backslash escapes inside quoted literals (MySQL default). */
  backslashEscapes?: boolean;
  /** `--` starts a comment only when followed by whitespace (MySQL). */
  mysqlDash?: boolean;
  /** `$$…$$` and `$tag$…$tag$` literals (PostgreSQL only). */
  dollarQuotes?: boolean;
  /** `#` starts a line comment (MySQL/MariaDB only). */
  hashComments?: boolean;
}

/** A single pass lexer: comment delimiters inside literals are never comments.
 * Without a negotiated SQL dialect, read admission must be safe under every
 * combination of the dialect-specific features in `ScanMode`, so a `$$…$$`
 * region or a `#` comment can never hide a statement from an engine that lacks
 * that syntax. This is deliberately a conservative valve, not a claim that
 * arbitrary SELECT functions are pure. */
function scanSql(sql: string, mode: ScanMode = {}): { text: string; valid: boolean } {
  const { backslashEscapes = false, mysqlDash = false, dollarQuotes = false, hashComments = false } = mode;
  const out: string[] = [];
  let i = 0;
  const invalid = () => ({ text: out.join(''), valid: false });
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c;
      out.push(c + end);
      i++;
      let closed = false;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === '\\' && c !== '[') { i += 2; continue; }
        if (sql[i] === end) {
          if (sql[i + 1] === end) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) return invalid();
      continue;
    }
    // Dollar quoting is unambiguous only as a complete delimited literal.
    if (dollarQuotes && c === '$') {
      const tag = /^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) return invalid();
        out.push("''"); i = end + tag.length; continue;
      }
    }
    if (c === '-' && sql[i + 1] === '-' && (!mysqlDash || i + 2 === sql.length || /\s/.test(sql[i + 2]!))) {
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out.push(' '); continue;
    }
    if (hashComments && c === '#') {
      i++;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out.push(' '); continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      // Executable MySQL/MariaDB comments and nested comments cannot be
      // discarded by a dialect-neutral permission check.
      if (sql[i + 2] === '!' || /^\/\*M!/i.test(sql.slice(i, i + 4))) return invalid();
      const end = sql.indexOf('*/', i + 2);
      const nested = sql.indexOf('/*', i + 2);
      if (end < 0 || (nested >= 0 && nested < end)) return invalid();
      out.push(' '); i = end + 2; continue;
    }
    out.push(c); i++;
  }
  return { text: out.join(''), valid: true };
}

export function stripSqlNoise(sql: string): string {
  const result = scanSql(sql, { dollarQuotes: true });
  return result.valid ? result.text : `${result.text} __INVALID_SQL__`;
}

const BOTH = [false, true] as const;
/** Every combination of the dialect-specific features; admission must hold in all of them. */
const SCAN_MODES: ScanMode[] = BOTH.flatMap((backslashEscapes) => BOTH.flatMap((mysqlDash) =>
  BOTH.flatMap((dollarQuotes) => BOTH.map((hashComments) => ({ backslashEscapes, mysqlDash, dollarQuotes, hashComments })))));

function interpretations(sql: string) {
  return SCAN_MODES.map((mode) => scanSql(sql, mode));
}

/** True when the buffer contains more than one top-level statement. */
export function hasMultipleStatements(sql: string): boolean {
  return interpretations(sql).some(({ text, valid }) => !valid || text.replace(/;+\s*$/, '').includes(';'));
}

export const WRITE_KW = /\b(insert|update|delete|drop|alter|create|truncate|replace|merge|grant|revoke|attach|detach|vacuum|reindex|call)\b/i;

/**
 * Mutating/locking forms that still begin with a nominally read verb.
 * `SELECT ... INTO` creates a table on SQL Server/Postgres and writes a server
 * file on MySQL (`INTO OUTFILE`). Sequence functions also mutate state, and
 * read-lock clauses are intentionally rejected on a connection advertised as
 * read-only.
 */
const READ_SIDE_EFFECT =
  /\b(?:into|for\s+(?:no\s+key\s+)?update|lock\s+in\s+share\s+mode|next\s+value\s+for)\b|\b(?:nextval|setval|dblink_exec|lo_(?:create|creat|import|put|unlink|truncate))\s*\(/i;

/**
 * Strict read-only classifier. A statement is read-safe only if it is a SINGLE
 * statement, leads with a read verb, is not `EXPLAIN ANALYZE` (which executes),
 * and contains NO write keyword anywhere (catches data-modifying CTEs like
 * `WITH x AS (DELETE …) …`). Conservative by design: a few benign statements
 * (writing-looking but harmless) may be rejected under read-only — that is the
 * safe failure direction for a security valve.
 */
export function isReadStatement(sql: string): boolean {
  return interpretations(sql).every(({ text, valid }) => valid && isReadText(text));
}

function isReadText(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (s.replace(/;+\s*$/, '').includes(';')) return false; // single statement only
  if (!/^(select|show|explain|describe|desc|with)\b/i.test(s)) return false;
  if (/^explain\b/i.test(s) && /\banalyze\b/i.test(s)) return false; // EXPLAIN ANALYZE runs it
  if (WRITE_KW.test(s)) return false; // writing CTE / any embedded write
  if (READ_SIDE_EFFECT.test(s)) return false; // SELECT INTO / locks / mutating read-shaped functions
  return true;
}
