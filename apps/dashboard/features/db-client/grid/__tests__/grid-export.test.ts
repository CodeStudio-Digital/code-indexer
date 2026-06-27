import { describe, it, expect } from 'vitest';
import { toCsv, toCsvBody, toJson, toTsv, toInsertSql, toDumpInserts, cellToCopy } from '../grid-export.js';

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

  it('dump INSERTs quote idents per engine (mysql backticks, else double-quotes)', () => {
    expect(toDumpInserts('mysql', 'users', cols, rows)).toContain('INSERT INTO `users` (`id`, `name`, `meta`) VALUES');
    expect(toDumpInserts('postgres', 'users', cols, rows)).toContain('INSERT INTO "users" ("id", "name", "meta") VALUES');
    expect(toDumpInserts('sqlite', 'users', cols, rows)).toContain('NULL');
  });

  it('toCsvBody emits rows without the header (for streamed batches)', () => {
    const body = toCsvBody(cols, rows);
    expect(body.startsWith('id,name,meta')).toBe(false);
    // toCsv === header line + the body, so appending batches reproduces the file.
    expect(toCsv(cols, rows)).toBe(`id,name,meta\n${body}`);
    expect(toCsvBody(cols, [{ id: 1, name: 'Ada', meta: null }])).toBe('1,Ada,');
  });

  it('cellToCopy renders null as empty', () => {
    expect(cellToCopy(null)).toBe('');
    expect(cellToCopy(42)).toBe('42');
    expect(cellToCopy({ a: 1 })).toBe('{"a":1}');
  });
});
