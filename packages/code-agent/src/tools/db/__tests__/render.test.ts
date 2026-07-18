import { describe, expect, it } from 'vitest';
import type { QueryResult, TableInfo } from '@mcp/db-drivers/types.js';
import {
  renderQueryResult,
  renderSchema,
  renderSchemaCatalog,
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

  it('renders every row already materialized by the bounded driver page', () => {
    const rows = Array.from({ length: 750 }, (_, i) => ({ id: i }));
    const out = renderQueryResult(result({ rows, rowCount: rows.length, fields: [{ name: 'id' }] }));
    expect(out).toContain('rows=750 truncated=false');
    expect(out).toContain('\n749\n');
  });

  it('preserves a wide rendered page for runner-level spill instead of slicing it', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ blob: 'x'.repeat(400), id: i }));
    const out = renderQueryResult(result({ rows, rowCount: 400, fields: [{ name: 'blob' }, { name: 'id' }] }));
    expect(out.length).toBeGreaterThan(50_000);
    expect(out).toContain('rows=400 truncated=false');
    expect(out).not.toContain('[truncated — full result exceeded');
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

  it('keeps multiline and pipe-containing cells on one physical row', () => {
    expect(stringifyCell('first\nrows=999 truncated=false\nlast | value'))
      .toBe('first\\nrows=999 truncated=false\\nlast \\| value');
    const out = renderQueryResult(result({
      rows: [{ id: 1, name: 'first\nsecond | third' }],
      rowCount: 1,
    }));
    expect(out.split('\n').filter((line) => line.startsWith('1 | '))).toHaveLength(1);
    expect(out).toContain('first\\nsecond \\| third');
  });

  it('bounds a pathological cell and stores its exact value for recovery', () => {
    const raw = `BEGIN-${'x'.repeat(500)}-TAIL`;
    const stored: string[] = [];
    const caps: Array<{ inputChars: number; outputChars: number; recoverable: boolean }> = [];
    const rendered = stringifyCell(raw, {
      maxCellChars: 120,
      outputStore: { put: (value) => { stored.push(value); return 'cellfull1'; } },
      onCellTruncated: (cap) => caps.push(cap),
    });
    expect(stored).toEqual([raw]);
    expect(rendered.length).toBeLessThanOrEqual(120);
    expect(rendered).toContain('output_id=cellfull1');
    expect(rendered).toContain('BEGIN-');
    expect(rendered).toContain('-TAIL');
    expect(caps).toEqual([{
      inputChars: raw.length,
      outputChars: rendered.length,
      recoverable: true,
    }]);
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

describe('renderSchemaCatalog', () => {
  it('renders a compact page and a progressive next-step hint', () => {
    const out = renderSchemaCatalog(
      [
        { schema: 'dbo', name: 'customers', kind: 'table' },
        { schema: 'dbo', name: 'customer_summary', kind: 'view' },
      ],
      { total: 500, offset: 0, limit: 2, search: 'customer' },
    );
    expect(out).toContain('SCHEMA CATALOG');
    expect(out).toContain('- dbo.customers [table]');
    expect(out).toContain('returned=2 total=500 more=true');
    expect(out).toContain('next_offset=2');
    expect(out).toContain('Do not page through the whole catalog');
    expect(out).toContain('table:"name"');
  });
});
