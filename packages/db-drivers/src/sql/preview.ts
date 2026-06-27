/**
 * One place that builds the paginated `SELECT *` for a table preview across all
 * engines — WHERE filter (parameterized), ORDER BY (sorted), and the engine's
 * pagination dialect (LIMIT/OFFSET vs OFFSET/FETCH). Pure + testable so the
 * placeholder numbering and injection-safety are pinned without a live DB.
 *
 * Injection-safe: column names are identifier-quoted, operators come from a
 * closed enum, and values bind as parameters (never interpolated).
 */
import { placeholder, quoteIdent, orderBySql } from './identifiers.js';
import type { DbEngine, TableSort, WhereCondition } from '../types.js';

const WHERE_OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'like']);

export interface PreviewOpts {
  limit: number;
  offset: number;
  orderBy?: TableSort;
  where?: WhereCondition[];
}

export function buildTablePreview(engine: DbEngine, rel: string, opts: PreviewOpts): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (v: unknown): string => {
    const p = placeholder(engine, params.length);
    params.push(v);
    return p;
  };

  let whereClause = '';
  if (opts.where?.length) {
    const parts: string[] = [];
    for (const c of opts.where) {
      if (!c.column) continue;
      const col = quoteIdent(engine, c.column);
      if (c.op === 'isnull') { parts.push(`${col} IS NULL`); continue; }
      if (c.op === 'isnotnull') { parts.push(`${col} IS NOT NULL`); continue; }
      if (!WHERE_OPS.has(c.op)) continue;
      const sqlOp = c.op === 'like' ? 'LIKE' : c.op;
      parts.push(`${col} ${sqlOp} ${bind(c.value ?? null)}`);
    }
    if (parts.length) whereClause = ` WHERE ${parts.join(' AND ')}`;
  }

  const ob = orderBySql(engine, opts.orderBy);
  // Fetch one extra row so `truncated` can signal more rows exist past the page.
  if (engine === 'mssql' || engine === 'oracle') {
    // OFFSET/FETCH — SQL Server REQUIRES an ORDER BY.
    const order = ob ? ` ORDER BY ${ob}` : engine === 'mssql' ? ' ORDER BY (SELECT NULL)' : '';
    const offP = bind(opts.offset);
    const limP = bind(opts.limit + 1);
    return { sql: `SELECT * FROM ${rel}${whereClause}${order} OFFSET ${offP} ROWS FETCH NEXT ${limP} ROWS ONLY`, params };
  }
  const order = ob ? ` ORDER BY ${ob}` : '';
  const limP = bind(opts.limit + 1);
  const offP = bind(opts.offset);
  return { sql: `SELECT * FROM ${rel}${whereClause}${order} LIMIT ${limP} OFFSET ${offP}`, params };
}
