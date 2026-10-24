import type { DbEngine } from '../types.js';

export interface SqlTableReference {
  schema?: string;
  table: string;
  alias?: string;
}

interface SqlDiagnostic {
  start: number;
  end: number;
  severity: 'warning' | 'error';
  code: 'write-without-where' | 'destructive-ddl' | 'join-without-on' | 'unresolved-table';
  message: string;
}

/** Preserve offsets/newlines while hiding strings and comments from regex passes. */
export function maskSql(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index];
    const next = sql[index + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      const stop = close < 0 ? sql.length : close + 2;
      out += sql.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      out += sql.slice(start, index).replace(/[^\n]/g, ' ');
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

function unquote(identifier: string): string {
  return identifier.replace(/^[`"\[]|[`"\]]$/g, '');
}

/** Extract concrete relations referenced by common DML clauses. */
export function extractTableReferences(sql: string): SqlTableReference[] {
  const masked = maskSql(sql);
  const refs: SqlTableReference[] = [];
  const pattern = /\b(?:from|join|update|into)\s+((?:[`"\[]?[A-Za-z_$][\w$]*[`"\]]?\.)?[`"\[]?[A-Za-z_$][\w$]*[`"\]]?)(?:\s+(?:as\s+)?((?!(?:where|join|left|right|inner|full|cross|on|set|values|group|order|limit|returning)\b)[A-Za-z_$][\w$]*))?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked))) {
    const parts = match[1].split('.').map(unquote);
    const alias = match[2] || undefined;
    refs.push(parts.length === 2
      ? { schema: parts[0], table: parts[1], alias }
      : { table: parts[0], alias });
  }
  return refs.filter((ref, index) => refs.findIndex((item) =>
    item.schema === ref.schema && item.table.toLowerCase() === ref.table.toLowerCase() && item.alias === ref.alias,
  ) === index);
}

export function completionContext(sql: string, offset: number): 'table' | 'column' {
  const prefix = maskSql(sql).slice(0, offset);
  return /\b(?:from|join|update|into)\s+(?:[`"\[]?[\w$]*[`"\]]?\.)?[`"\[]?[\w$]*$/i.test(prefix)
    ? 'table'
    : 'column';
}

export function findNamedParameters(sql: string): string[] {
  const masked = maskSql(sql);
  const names: string[] = [];
  const pattern = /(^|[^:]):([A-Za-z_][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked))) {
    if (!names.includes(match[2])) names.push(match[2]);
  }
  return names;
}

function placeholder(engine: DbEngine | undefined, index: number): string {
  if (engine === 'postgres') return `$${index + 1}`;
  if (engine === 'oracle') return `:${index + 1}`;
  if (engine === 'mssql') return `@p${index}`;
  return '?';
}

/** Replace :name outside comments/strings and return positional driver params. */
export function bindNamedParameters(
  sql: string,
  values: Record<string, unknown>,
  engine?: DbEngine,
): { sql: string; params: unknown[] } {
  const masked = maskSql(sql);
  const params: unknown[] = [];
  let output = '';
  let cursor = 0;
  const pattern = /(^|[^:]):([A-Za-z_][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked))) {
    const colon = match.index + match[1].length;
    const name = match[2];
    output += sql.slice(cursor, colon) + placeholder(engine, params.length);
    params.push(values[name]);
    cursor = colon + name.length + 1;
  }
  output += sql.slice(cursor);
  return { sql: output, params };
}

export function parseParameterValue(raw: string): unknown {
  const value = raw.trim();
  if (/^null$/i.test(value)) return null;
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch { /* keep as text */ }
  }
  return raw;
}

function statementRanges(masked: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    if (index === masked.length || masked[index] === ';') {
      if (masked.slice(start, index).trim()) out.push({ start, end: index });
      start = index + 1;
    }
  }
  return out;
}

export function analyzeSql(sql: string, knownTables: string[] = []): SqlDiagnostic[] {
  const masked = maskSql(sql);
  const diagnostics: SqlDiagnostic[] = [];
  for (const range of statementRanges(masked)) {
    const statement = masked.slice(range.start, range.end);
    const write = /\b(update|delete\s+from)\b/i.exec(statement);
    if (write && !/\bwhere\b/i.test(statement)) {
      diagnostics.push({
        start: range.start + write.index,
        end: range.start + write.index + write[0].length,
        severity: 'error',
        code: 'write-without-where',
        message: 'UPDATE/DELETE sem WHERE pode alterar todas as linhas.',
      });
    }
    const destructive = /\b(drop\s+(?:table|schema|database)|truncate\s+table)\b/i.exec(statement);
    if (destructive) diagnostics.push({
      start: range.start + destructive.index,
      end: range.start + destructive.index + destructive[0].length,
      severity: 'warning',
      code: 'destructive-ddl',
      message: 'DDL destrutivo: revise o alvo antes de executar.',
    });
    const join = /\bjoin\s+[^;]+$/i.exec(statement);
    if (join && !/\bon\b/i.test(join[0]) && !/\bcross\s+join\b/i.test(join[0])) diagnostics.push({
      start: range.start + join.index,
      end: range.start + join.index + 4,
      severity: 'warning',
      code: 'join-without-on',
      message: 'JOIN sem ON pode produzir um produto cartesiano.',
    });
  }
  if (knownTables.length > 0) {
    const known = new Set(knownTables.map((name) => name.toLowerCase()));
    for (const ref of extractTableReferences(sql)) {
      if (known.has(ref.table.toLowerCase())) continue;
      const match = new RegExp(`\\b${ref.table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(masked);
      if (match) diagnostics.push({
        start: match.index,
        end: match.index + ref.table.length,
        severity: 'warning',
        code: 'unresolved-table',
        message: `Tabela ou view não encontrada no catálogo carregado: ${ref.table}.`,
      });
    }
  }
  return diagnostics;
}
