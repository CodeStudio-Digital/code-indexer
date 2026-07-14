import { describe, expect, it } from 'vitest';
import { coerceColumnValue, editorSpecForColumn, formatColumnValue, parseEnumValues } from '../column-editor.js';

describe('database column editors', () => {
  it('derives controls from common SQL types', () => {
    expect(editorSpecForColumn({ dataType: 'jsonb' }).kind).toBe('json');
    expect(editorSpecForColumn({ dataType: 'timestamp with time zone' }).kind).toBe('datetime');
    expect(editorSpecForColumn({ dataType: 'DATE' }).kind).toBe('date');
    expect(editorSpecForColumn({ dataType: 'decimal(10,2)' }).kind).toBe('number');
    expect(editorSpecForColumn({ dataType: 'BOOLEAN' }).kind).toBe('boolean');
  });

  it('extracts enum literals safely', () => {
    expect(parseEnumValues("enum('draft','published','can\\'t')")).toEqual(['draft', 'published', "can't"]);
    expect(editorSpecForColumn({ dataType: "ENUM('a','b')" })).toEqual({ kind: 'enum', enumValues: ['a', 'b'] });
  });

  it('uses enum values exposed by database introspection', () => {
    expect(editorSpecForColumn({ dataType: 'order_status', enumValues: ['draft', 'paid'] })).toEqual({
      kind: 'enum',
      enumValues: ['draft', 'paid'],
    });
  });

  it('formats and coerces JSON, booleans and numbers', () => {
    const json = editorSpecForColumn({ dataType: 'JSON' });
    expect(formatColumnValue({ a: 1 }, json)).toContain('"a": 1');
    expect(coerceColumnValue('{"a":2}', json)).toEqual({ a: 2 });
    expect(coerceColumnValue('false', editorSpecForColumn({ dataType: 'bool' }))).toBe(false);
    expect(coerceColumnValue('42.5', editorSpecForColumn({ dataType: 'numeric' }))).toBe(42.5);
  });
});
