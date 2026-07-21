import type { DbQueryResult } from '../types.js';

type TokenKind = 'word' | 'identifier' | 'number' | 'string' | 'symbol';

interface SqlToken {
  kind: TokenKind;
  value: string;
}

export interface SqlResultEditability {
  /** The statement maps each result row to the currently opened table. */
  singleTable: boolean;
  /** Every table column is present, so FK navigation has all required values. */
  completeRow: boolean;
  /** Inline UPDATE/DELETE is safe because the result also carries its PK. */
  editable: boolean;
  reason: 'editable' | 'not-single-table' | 'unknown-column' | 'missing-primary-key';
}

const CLAUSE_WORDS = new Set([
  'where', 'order', 'limit', 'offset', 'fetch', 'for', 'option', 'returning',
]);
const UNSAFE_WORDS = new Set([
  'join', 'left', 'right', 'inner', 'full', 'cross', 'natural', 'apply', 'outer',
  'union', 'intersect', 'except', 'group', 'having', 'window', 'qualify', 'into',
]);

function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index];
    const next = sql[index + 1];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      let value = ch;
      index += 1;
      while (index < sql.length) {
        value += sql[index];
        if (sql[index] === "'" && sql[index + 1] === "'") {
          value += sql[index + 1];
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let value = '';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === close && sql[index + 1] === close) {
          value += close;
          index += 2;
          continue;
        }
        if (sql[index] === close) {
          index += 1;
          break;
        }
        value += sql[index];
        index += 1;
      }
      tokens.push({ kind: 'identifier', value });
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(sql.slice(index));
    if (word) {
      tokens.push({ kind: 'word', value: word[0] });
      index += word[0].length;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(sql.slice(index));
    if (number) {
      tokens.push({ kind: 'number', value: number[0] });
      index += number[0].length;
      continue;
    }
    tokens.push({ kind: 'symbol', value: ch });
    index += 1;
  }
  return tokens;
}

function word(token: SqlToken | undefined): string {
  return token?.kind === 'word' ? token.value.toLocaleLowerCase() : '';
}

function identifier(token: SqlToken | undefined): string | null {
  return token && (token.kind === 'word' || token.kind === 'identifier') ? token.value : null;
}

function trimTrailingSemicolons(tokens: SqlToken[]): SqlToken[] {
  let end = tokens.length;
  while (end > 0 && tokens[end - 1].value === ';') end -= 1;
  return tokens.slice(0, end);
}

function selectItems(tokens: SqlToken[]): { valid: boolean; star: boolean; columns: string[] } {
  let start = 0;
  if (word(tokens[start]) === 'all') start += 1;
  if (word(tokens[start]) === 'distinct') return { valid: false, star: false, columns: [] };
  // SQL Server's SELECT TOP n / TOP (n) prefix does not change row identity.
  if (word(tokens[start]) === 'top') {
    start += 1;
    if (tokens[start]?.value === '(') {
      if (tokens[start + 1]?.kind !== 'number' || tokens[start + 2]?.value !== ')') return { valid: false, star: false, columns: [] };
      start += 3;
    } else if (tokens[start]?.kind === 'number') {
      start += 1;
    } else {
      return { valid: false, star: false, columns: [] };
    }
    if (word(tokens[start]) === 'percent') start += 1;
    if (word(tokens[start]) === 'with' && word(tokens[start + 1]) === 'ties') start += 2;
  }

  const items: SqlToken[][] = [];
  let item: SqlToken[] = [];
  for (const token of tokens.slice(start)) {
    if (token.value === ',') {
      if (item.length === 0) return { valid: false, star: false, columns: [] };
      items.push(item);
      item = [];
    } else {
      item.push(token);
    }
  }
  if (item.length > 0) items.push(item);
  if (items.length === 0) return { valid: false, star: false, columns: [] };

  let star = false;
  const columns: string[] = [];
  for (const current of items) {
    if (current.length === 1 && current[0].value === '*') {
      star = true;
      continue;
    }
    if (current.length === 1) {
      const column = identifier(current[0]);
      if (!column) return { valid: false, star: false, columns: [] };
      columns.push(column);
      continue;
    }
    if (current.length === 3 && identifier(current[0]) && current[1].value === '.') {
      if (current[2].value === '*') star = true;
      else {
        const column = identifier(current[2]);
        if (!column) return { valid: false, star: false, columns: [] };
        columns.push(column);
      }
      continue;
    }
    // Expressions and aliases do not map reliably back to a physical column.
    return { valid: false, star: false, columns: [] };
  }
  return { valid: true, star, columns };
}

function resultColumns(result: DbQueryResult | null): string[] {
  if (!result) return [];
  if (result.fields.length > 0) return result.fields.map((field) => field.name);
  return result.rows[0] ? Object.keys(result.rows[0]) : [];
}

/**
 * Conservative updatability check for custom SQL shown inside a table tab.
 * Only a single-table SELECT whose output is made of physical table columns is
 * editable. Joins, projections/aliases, aggregates and missing PKs stay read-only.
 */
export function analyzeSqlResultEditability({
  sql,
  schema,
  table,
  primaryKeyColumns,
  tableColumns,
  result,
}: {
  sql: string;
  schema: string;
  table: string;
  primaryKeyColumns: string[];
  tableColumns: string[];
  result: DbQueryResult | null;
}): SqlResultEditability {
  const fail = (): SqlResultEditability => ({ singleTable: false, completeRow: false, editable: false, reason: 'not-single-table' });
  const tokens = trimTrailingSemicolons(tokenize(sql));
  if (word(tokens[0]) !== 'select' || tokens.some((token, index) => token.value === ';' && index < tokens.length - 1)) return fail();
  if (tokens.slice(1).some((token) => word(token) === 'select')) return fail();

  let depth = 0;
  let fromIndex = -1;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index].value === '(') depth += 1;
    else if (tokens[index].value === ')') depth -= 1;
    else if (depth === 0 && word(tokens[index]) === 'from') {
      fromIndex = index;
      break;
    }
  }
  if (fromIndex < 0) return fail();
  const selected = selectItems(tokens.slice(1, fromIndex));
  if (!selected.valid) return fail();

  let cursor = fromIndex + 1;
  const first = identifier(tokens[cursor]);
  if (!first) return fail();
  cursor += 1;
  let refSchema: string | undefined;
  let refTable = first;
  if (tokens[cursor]?.value === '.') {
    const second = identifier(tokens[cursor + 1]);
    if (!second) return fail();
    refSchema = first;
    refTable = second;
    cursor += 2;
  }
  if (word(tokens[cursor]) === 'as') {
    if (!identifier(tokens[cursor + 1])) return fail();
    cursor += 2;
  } else if (identifier(tokens[cursor]) && !CLAUSE_WORDS.has(word(tokens[cursor])) && !UNSAFE_WORDS.has(word(tokens[cursor]))) {
    cursor += 1; // bare alias
  }

  depth = 0;
  for (let index = cursor; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '(') depth += 1;
    else if (token.value === ')') depth -= 1;
    if (word(token) === 'select' || UNSAFE_WORDS.has(word(token))) return fail();
    if (depth === 0 && (token.value === ',' || word(token) === 'from')) return fail();
  }
  if (refTable.toLocaleLowerCase() !== table.toLocaleLowerCase()) return fail();
  if (refSchema && schema && refSchema.toLocaleLowerCase() !== schema.toLocaleLowerCase()) return fail();

  const output = resultColumns(result);
  const outputSet = new Set(output.map((column) => column.toLocaleLowerCase()));
  const knownSet = new Set(tableColumns.map((column) => column.toLocaleLowerCase()));
  const selectedSet = new Set(selected.columns.map((column) => column.toLocaleLowerCase()));
  const onlyKnownColumns = output.length > 0
    && output.every((column) => knownSet.has(column.toLocaleLowerCase()))
    && (selected.star || output.every((column) => selectedSet.has(column.toLocaleLowerCase())));
  const completeRow = onlyKnownColumns && tableColumns.every((column) => outputSet.has(column.toLocaleLowerCase()));
  if (!onlyKnownColumns) return { singleTable: true, completeRow: false, editable: false, reason: 'unknown-column' };
  const hasPrimaryKey = primaryKeyColumns.length > 0
    && primaryKeyColumns.every((column) => outputSet.has(column.toLocaleLowerCase()));
  if (!hasPrimaryKey) return { singleTable: true, completeRow, editable: false, reason: 'missing-primary-key' };
  return { singleTable: true, completeRow, editable: true, reason: 'editable' };
}
