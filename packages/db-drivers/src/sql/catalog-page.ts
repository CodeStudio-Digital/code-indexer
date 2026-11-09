import { placeholder } from './identifiers.js';
import type { DbEngine } from '../types.js';

export interface CatalogPageOptions { schema?: string; query?: string; after?: [string, string, string]; limit?: number }

/** Names only, keyset-paged at the server. No table/column introspection. */
export function buildCatalogPage(engine: DbEngine, opts: CatalogPageOptions = {}) {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200) || 200));
  let source: string;
  switch (engine) {
    case 'postgres': source = `SELECT n.nspname AS schema_name, CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END AS object_kind, c.relname AS object_name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','S') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      UNION SELECT n.nspname, 'function', p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')`; break;
    case 'mysql': case 'mariadb': source = `SELECT TABLE_SCHEMA AS schema_name, CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END AS object_kind, TABLE_NAME AS object_name FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys') UNION SELECT ROUTINE_SCHEMA, 'function', ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')`; break;
    case 'mssql': source = `SELECT s.name AS schema_name, CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'SO' THEN 'sequence' ELSE 'function' END AS object_kind, o.name AS object_name FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V','SO','P','FN','IF','TF') AND o.is_ms_shipped=0`; break;
    case 'oracle': source = `SELECT owner AS schema_name, CASE object_type WHEN 'TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' WHEN 'SEQUENCE' THEN 'sequence' ELSE 'function' END AS object_kind, object_name FROM all_objects WHERE object_type IN ('TABLE','VIEW','SEQUENCE','FUNCTION','PROCEDURE')`; break;
    case 'sqlite': source = `SELECT 'main' AS schema_name, type AS object_kind, name AS object_name FROM main.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`; break;
    default: throw new Error(`Catalog paging unsupported for ${engine}`);
  }
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return placeholder(engine, params.length - 1); };
  const predicates: string[] = [];
  if (opts.schema) predicates.push(`schema_name = ${bind(opts.schema)}`);
  if (opts.query?.trim()) {
    const pattern = `%${opts.query.trim().slice(0, 128).toLowerCase().replace(/[!%_]/g, '!$&')}%`;
    predicates.push(`(LOWER(object_name) LIKE ${bind(pattern)} ESCAPE '!' OR LOWER(schema_name) LIKE ${bind(pattern)} ESCAPE '!')`);
  }
  if (opts.after) {
    const [schema, kind, name] = opts.after;
    predicates.push(`(schema_name > ${bind(schema)} OR (schema_name = ${bind(schema)} AND object_kind > ${bind(kind)}) OR (schema_name = ${bind(schema)} AND object_kind = ${bind(kind)} AND object_name > ${bind(name)}))`);
  }
  const top = engine === 'mssql' ? `TOP (${limit + 1}) ` : '';
  const tail = engine === 'oracle' ? ` FETCH FIRST ${limit + 1} ROWS ONLY` : engine === 'mssql' ? '' : ` LIMIT ${limit + 1}`;
  return { sql: `WITH catalog AS (${source}) SELECT ${top}schema_name, object_kind, object_name FROM catalog${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY schema_name, object_kind, object_name${tail}`, params, limit };
}
