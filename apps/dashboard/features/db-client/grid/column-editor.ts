import type { DbColumn } from '../types.js';

export type ColumnEditorKind = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'time' | 'json' | 'enum';

export interface ColumnEditorSpec {
  kind: ColumnEditorKind;
  enumValues: string[];
}

/** Extract MySQL/MariaDB ENUM/SET literals without evaluating the type string. */
export function parseEnumValues(dataType: string): string[] {
  if (!/^\s*(?:enum|set)\s*\(/i.test(dataType)) return [];
  const values: string[] = [];
  const body = dataType.slice(dataType.indexOf('(') + 1, dataType.lastIndexOf(')'));
  const re = /'((?:\\.|''|[^'])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    values.push(match[1].replace(/''/g, "'").replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  return values;
}

export function editorSpecForColumn(column: Pick<DbColumn, 'dataType' | 'enumValues'>): ColumnEditorSpec {
  const type = column.dataType.trim().toLowerCase();
  const enumValues = column.enumValues?.length ? column.enumValues : parseEnumValues(column.dataType);
  if (enumValues.length > 0) return { kind: 'enum', enumValues };
  if (/\b(?:json|jsonb)\b/.test(type)) return { kind: 'json', enumValues: [] };
  if (/\b(?:bool|boolean)\b/.test(type) || /^bit\s*\(\s*1\s*\)$/.test(type)) return { kind: 'boolean', enumValues: [] };
  if (/\b(?:timestamp|datetime|datetime2|smalldatetime|timestamptz)\b/.test(type)) return { kind: 'datetime', enumValues: [] };
  if (/^date\b/.test(type)) return { kind: 'date', enumValues: [] };
  if (/^time\b/.test(type)) return { kind: 'time', enumValues: [] };
  if (/\b(?:tinyint|smallint|mediumint|bigint|integer|int|decimal|numeric|number|float|double|real|money|serial)\b/.test(type)) {
    return { kind: 'number', enumValues: [] };
  }
  return { kind: 'text', enumValues: [] };
}

export function formatColumnValue(value: unknown, spec: ColumnEditorSpec): string {
  if (value == null) return '';
  if (spec.kind === 'json') {
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    try {
      return JSON.stringify(JSON.parse(String(value)), null, 2);
    } catch {
      return String(value);
    }
  }
  if (spec.kind === 'datetime') return String(value).replace(' ', 'T').slice(0, 16);
  if (spec.kind === 'date') return String(value).slice(0, 10);
  if (spec.kind === 'time') {
    const match = String(value).match(/(?:T|\s)?(\d{2}:\d{2}(?::\d{2})?)/);
    return match?.[1] ?? String(value);
  }
  return String(value);
}

export function coerceColumnValue(draft: string, spec: ColumnEditorSpec): unknown {
  if (spec.kind === 'json') return JSON.parse(draft);
  if (spec.kind === 'boolean') return draft === 'true' || draft === '1';
  if (spec.kind === 'number') {
    const value = Number(draft);
    return Number.isFinite(value) ? value : draft;
  }
  return draft;
}

/**
 * Inline-grid variant of `coerceColumnValue`.
 *
 * The grid has no per-field NULL toggle the way the row dialog does, so an
 * emptied cell means NULL for every non-text column — `Number('')` is 0, which
 * would silently write a zero where the user meant "clear this". Invalid JSON
 * stays text so the engine reports the real parse error instead of the UI
 * swallowing the keystroke.
 */
export function coerceCellInput(raw: string, spec: ColumnEditorSpec): unknown {
  if (raw === '' && spec.kind !== 'text') return null;
  try {
    return coerceColumnValue(raw, spec);
  } catch {
    return raw;
  }
}
