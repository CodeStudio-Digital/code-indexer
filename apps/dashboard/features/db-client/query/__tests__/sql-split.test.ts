import { describe, it, expect } from 'vitest';
import { splitStatements } from '../sql-split.js';

describe('splitStatements', () => {
  it('splits on top-level semicolons and trims', () => {
    expect(splitStatements('SELECT 1; SELECT 2 ;\nSELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('ignores semicolons inside single-quoted strings', () => {
    expect(splitStatements(`INSERT INTO t (s) VALUES ('a;b'); SELECT 1`)).toEqual([
      `INSERT INTO t (s) VALUES ('a;b')`,
      'SELECT 1',
    ]);
  });

  it('handles doubled-quote escapes', () => {
    expect(splitStatements(`SELECT 'O''Brien; x'; SELECT 2`)).toEqual([`SELECT 'O''Brien; x'`, 'SELECT 2']);
  });

  it('ignores semicolons in backtick idents and double quotes', () => {
    expect(splitStatements('SELECT `a;b` FROM t; SELECT "c;d"')).toEqual(['SELECT `a;b` FROM t', 'SELECT "c;d"']);
  });

  it('ignores semicolons in line and block comments', () => {
    expect(splitStatements('SELECT 1 -- a; b\n; SELECT 2 /* x; y */; SELECT 3')).toEqual([
      'SELECT 1 -- a; b',
      'SELECT 2 /* x; y */',
      'SELECT 3',
    ]);
  });

  it('drops empty statements and a single statement returns one', () => {
    expect(splitStatements('  ; ;SELECT 1;  ')).toEqual(['SELECT 1']);
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
    expect(splitStatements('   ')).toEqual([]);
  });
});
