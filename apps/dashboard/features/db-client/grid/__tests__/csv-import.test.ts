import { describe, it, expect } from 'vitest';
import { parseCsv, rowsToRecords } from '../csv-import.js';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with commas, newlines and doubled quotes', () => {
    expect(parseCsv('name,note\n"Ada, L.","say ""hi""\nok"')).toEqual([
      ['name', 'note'],
      ['Ada, L.', 'say "hi"\nok'],
    ]);
  });

  it('keeps trailing empty fields and ignores a trailing newline + BOM', () => {
    expect(parseCsv('﻿a,\n1,2\n')).toEqual([
      ['a', ''],
      ['1', '2'],
    ]);
  });
});

describe('rowsToRecords', () => {
  it('keys by header and turns empty cells into null', () => {
    expect(rowsToRecords(['id', 'name'], [['1', 'Ada'], ['2', '']])).toEqual([
      { id: '1', name: 'Ada' },
      { id: '2', name: null },
    ]);
  });
});
