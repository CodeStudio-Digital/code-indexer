import { describe, expect, it } from 'vitest';
import type { QueryResult, TableInfo } from '@mcp/db-drivers/types.js';
import {
  MAX_RENDER_ROWS,
  MAX_RESULT_CHARS,
  renderQueryResult,
  renderSchema,
  stringifyCell,
} from '../render.js';

const result = (over: Partial<QueryResult> = {}): QueryResult => ({
  rows: [
    { id: 1, name: 'a' },
    { id: 2, name: null },
  ],
  rowCount: 2,
  fields: [{ name: 'id' }, { name: 'name' }],
  ...over,
});

describe('renderQueryResult', () => {
  it('renders a markdown table with the rows/truncated footer', () => {
    const out = renderQueryResult(result());
    expect(out).toContain('id | name');
    expect(out).toContain('--- | ---');
    expect(out).toContain('1 | a');
    expect(out).toContain('2 | NULL');
    expect(out).toContain('rows=2 truncated=false');
    expect(out).not.toContain('LIMIT/OFFSET');
  });

  it('no rows → affected-count line (with the command verb when known)', () => {
    const out = renderQueryResult(result({ rows: [], rowCount: 3, fields: [], command: 'UPDATE' }));
    expect(out).toContain('OK (UPDATE) — 3 row(s) affected.');
    expect(out).toContain('rows=0 truncated=false');
  });

  it('driver-level truncation surfaces in the footer with a pagination hint', () => {
    const out = renderQueryResult(result({ truncated: true }));
    expect(out).toContain('rows=2 truncated=true');
    expect(out).toContain('LIMIT/OFFSET');
  });

  it(`render row cap: more than ${MAX_RENDER_ROWS} rows are elided`, () => {
    const rows = Array.from({ length: MAX_RENDER_ROWS + 50 }, (_, i) => ({ id: i }));
    const out = renderQueryResult(result({ rows, rowCount: rows.length, fields: [{ name: 'id' }] }));
    expect(out).toContain(`rows=${MAX_RENDER_ROWS} truncated=true`);
  });

  it('char-level safety net caps the total output', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ blob: 'x'.repeat(400), id: i }));
    const out = renderQueryResult(result({ rows, rowCount: 400, fields: [{ name: 'blob' }, { name: 'id' }] }));
    expect(out.length).toBeLessThan(MAX_RESULT_CHARS + 200);
    expect(out).toContain('[truncated — full result exceeded');
  });
});

describe('stringifyCell', () => {
  it('handles NULL / dates / objects', () => {
    expect(stringifyCell(null)).toBe('NULL');
    expect(stringifyCell(undefined)).toBe('NULL');
    expect(stringifyCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(stringifyCell({ a: 1 })).toBe('{"a":1}');
    expect(stringifyCell(7)).toBe('7');
  });
});

describe('renderSchema', () => {
  it('renders one block per table with PK/null flags', () => {
    const tables: TableInfo[] = [
      {
        schema: 'public',
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true },
          { name: 'email', dataType: 'text', nullable: true, isPrimaryKey: false },
        ],
      },
    ];
    const out = renderSchema(tables);
    expect(out).toContain('TABLE public.users');
    expect(out).toContain('id: integer NOT NULL [PK]');
    expect(out).toContain('email: text NULL');
  });

  it('empty schema → didactic note', () => {
    expect(renderSchema([])).toContain('no tables in schema');
  });
});
