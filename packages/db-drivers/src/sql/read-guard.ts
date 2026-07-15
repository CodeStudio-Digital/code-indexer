/**
 * Read-vs-write SQL classification — the read-only valve shared by the
 * embedded DB client handlers (`@mcp/api-handlers` dbClient) and the `db_*`
 * agent tools. Pure string analysis, no engine connection required.
 *
 * Moved verbatim from `packages/api-handlers/src/db-client/index.ts` so both
 * consumers guard with the SAME rules (one classifier, one failure direction).
 */

/** Strip comments + string/identifier literals so keyword/`;` checks aren't fooled. */
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/`(?:``|[^`])*`/g, '``');
}

/** True when the buffer contains more than one top-level statement. */
export function hasMultipleStatements(sql: string): boolean {
  return stripSqlNoise(sql).replace(/;+\s*$/, '').includes(';');
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
  const s = stripSqlNoise(sql).trim();
  if (!s) return false;
  if (s.replace(/;+\s*$/, '').includes(';')) return false; // single statement only
  if (!/^(select|show|explain|describe|desc|with)\b/i.test(s)) return false;
  if (/^explain\b/i.test(s) && /\banalyze\b/i.test(s)) return false; // EXPLAIN ANALYZE runs it
  if (WRITE_KW.test(s)) return false; // writing CTE / any embedded write
  if (READ_SIDE_EFFECT.test(s)) return false; // SELECT INTO / locks / mutating read-shaped functions
  return true;
}
