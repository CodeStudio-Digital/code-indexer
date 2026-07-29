/**
 * Drivers hand the grid real JS values, not strings: `pg` returns `Date` for
 * timestamps, `mysql2` returns `Buffer` for BLOB/BINARY, and every engine
 * returns `bigint` for 64-bit integers. The grid used to render them with a
 * bare `String(v)` / `JSON.stringify(v)`, which printed a locale-formatted date
 * and turned a blob into `{"0":137,"1":80,…}`.
 *
 * That was not only ugly: the inline editor seeds its input from this exact
 * text, so the mangled rendering became the value written back to the row.
 * These tests pin the display contract and the input coercion that closes it.
 */
import { describe, expect, it } from 'vitest';
import { cellText, isBinaryValue } from '../grid-utils.js';
import { coerceCellInput, editorSpecForColumn } from '../column-editor.js';

const specFor = (dataType: string) => editorSpecForColumn({ dataType });

describe('cellText', () => {
  it('renders NULL as empty (the grid draws its own ∅ marker)', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
  });

  it('renders a timestamp as a stable, sortable string', () => {
    expect(cellText(new Date('2026-07-25T13:45:07.000Z'))).toBe('2026-07-25 13:45:07');
  });

  it('does not crash on an invalid date', () => {
    expect(cellText(new Date('nope'))).toBe('Invalid Date');
  });

  it('renders binary as a hex preview with a byte count, not an object dump', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(cellText(png)).toBe('0x89504e47');
    const big = new Uint8Array(64).fill(0xab);
    expect(cellText(big)).toMatch(/^0x(?:ab){24}… \(64 B\)$/);
  });

  it('handles the JSON-transported Buffer shape from the HTTP fallback', () => {
    expect(cellText({ type: 'Buffer', data: [1, 2, 255] })).toBe('0x0102ff');
  });

  it('keeps primitives readable', () => {
    expect(cellText('hello')).toBe('hello');
    expect(cellText(42)).toBe('42');
    expect(cellText(10n ** 20n)).toBe('100000000000000000000');
    expect(cellText(false)).toBe('false');
  });

  it('serializes a json column value compactly', () => {
    expect(cellText({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
  });
});

describe('isBinaryValue', () => {
  it('flags the values the inline editor must not round-trip through text', () => {
    expect(isBinaryValue(new Uint8Array([1]))).toBe(true);
    expect(isBinaryValue(new ArrayBuffer(4))).toBe(true);
    expect(isBinaryValue({ type: 'Buffer', data: [1] })).toBe(true);
  });

  it('leaves ordinary values editable', () => {
    expect(isBinaryValue('0x89504e47')).toBe(false);
    expect(isBinaryValue({ a: 1 })).toBe(false);
    expect(isBinaryValue(null)).toBe(false);
    expect(isBinaryValue(new Date())).toBe(false);
  });
});

describe('coerceCellInput', () => {
  it('sends a number for a numeric column, not the typed string', () => {
    expect(coerceCellInput('42', specFor('integer'))).toBe(42);
    expect(coerceCellInput('3.5', specFor('numeric'))).toBe(3.5);
  });

  it('clears a numeric cell to NULL instead of writing 0', () => {
    expect(coerceCellInput('', specFor('bigint'))).toBeNull();
  });

  it('keeps an empty string on a text column (that is a real value)', () => {
    expect(coerceCellInput('', specFor('varchar(20)'))).toBe('');
  });

  it('sends a real boolean for a boolean column', () => {
    expect(coerceCellInput('true', specFor('boolean'))).toBe(true);
    expect(coerceCellInput('0', specFor('boolean'))).toBe(false);
  });

  it('parses a json column value', () => {
    expect(coerceCellInput('{"a":1}', specFor('jsonb'))).toEqual({ a: 1 });
  });

  it('lets invalid json through as text so the engine reports the real error', () => {
    expect(coerceCellInput('{oops', specFor('jsonb'))).toBe('{oops');
  });

  it('leaves a non-numeric draft alone rather than writing NaN', () => {
    expect(coerceCellInput('N/A', specFor('int'))).toBe('N/A');
  });
});
