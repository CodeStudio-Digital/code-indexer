import { describe, it, expect } from 'vitest';
import { toCsv, toJson, toTsv, toInsertSql, cellToCopy } from '../grid-export.js';

const cols = ['id', 'name', 'meta'];
const rows = [
  { id: 1, name: 'Ada, "the count"', meta: { a: 1 } },
  { id: 2, name: 'Linus\nTorvalds', meta: null },
];

describe('grid-export', () => {
  it('CSV quotes commas/quotes/newlines and stringifies objects', () => {
    const csv = toCsv(cols, rows);
    expect(csv.split('\n')[0]).toBe('id,name,meta');
    expect(csv).toContain('"Ada, ""the count"""'); // comma + escaped quotes
    expect(csv).toContain('"Linus\nTorvalds"'); // newline quoted
    expect(csv).toContain('"{""a"":1}"'); // object → JSON, quoted
  });

  it('JSON emits an array of objects with nulls preserved', () => {
    const parsed = JSON.parse(toJson(cols, rows)) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[1].meta).toBeNull();
    expect(parsed[0].meta).toEqual({ a: 1 });
  });

  it('TSV collapses tabs/newlines for clipboard', () => {
    const tsv = toTsv(cols, rows);
    expect(tsv.split('\n')[0]).toBe('id\tname\tmeta');
    expect(tsv).toContain('Linus Torvalds'); // newline collapsed to space
  });

  it('INSERT SQL escapes strings + renders NULL', () => {
    const sql = toInsertSql('users', cols, rows);
    expect(sql).toContain('INSERT INTO "users" ("id", "name", "meta") VALUES');
    expect(sql).toContain("'Ada, \"the count\"'");
    expect(sql).toContain('NULL'); // row 2 meta
  });

  it('cellToCopy renders null as empty', () => {
    expect(cellToCopy(null)).toBe('');
    expect(cellToCopy(42)).toBe('42');
    expect(cellToCopy({ a: 1 })).toBe('{"a":1}');
  });
});
