import { describe, expect, it, vi } from 'vitest';
import type { DatabaseDriver, TableInfo, TableRef } from '@mcp/db-drivers/types.js';
import { DEFAULT_SCHEMA_PAGE_SIZE, defaultSchemaFromOptions, inspectRelationalSchema } from '../tools.js';

function fakeDriver(tableCount = 500): {
  driver: DatabaseDriver;
  listTables: ReturnType<typeof vi.fn>;
  describeTable: ReturnType<typeof vi.fn>;
} {
  const refs: TableRef[] = Array.from({ length: tableCount }, (_, i) => ({
    schema: 'dbo',
    name: `table_${String(i).padStart(3, '0')}`,
    kind: 'table',
  }));
  const listTables = vi.fn(async () => refs);
  const describeTable = vi.fn(async (schema: string, name: string): Promise<TableInfo> => ({
    schema,
    name,
    columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }],
  }));
  return {
    listTables,
    describeTable,
    driver: { listTables, describeTable } as unknown as DatabaseDriver,
  };
}

describe('progressive db_schema inspection', () => {
  it('reads the schema filter saved by the connection dialog', () => {
    expect(defaultSchemaFromOptions('{"defaultSchema":"  dbo  "}')).toBe('dbo');
    expect(defaultSchemaFromOptions('{broken')).toBeUndefined();
  });

  it('lists only one compact page and performs zero per-table introspections', async () => {
    const { driver, listTables, describeTable } = fakeDriver(500);
    const out = await inspectRelationalSchema(driver, {});
    expect(listTables).toHaveBeenCalledOnce();
    expect(describeTable).not.toHaveBeenCalled();
    expect(out).toContain(`returned=${DEFAULT_SCHEMA_PAGE_SIZE} total=500 more=true`);
    expect(out.length).toBeLessThan(5_000);
  });

  it('searches names before paging without expanding matching tables', async () => {
    const { driver, describeTable } = fakeDriver(500);
    const out = await inspectRelationalSchema(driver, { search: 'table_49', limit: 5 });
    expect(describeTable).not.toHaveBeenCalled();
    expect(out).toContain('dbo.table_490');
    expect(out).toContain('returned=5 total=10');
  });

  it('expands exactly one requested table', async () => {
    const { driver, describeTable } = fakeDriver(500);
    const out = await inspectRelationalSchema(driver, { table: 'TABLE_042' });
    expect(describeTable).toHaveBeenCalledOnce();
    expect(describeTable).toHaveBeenCalledWith('dbo', 'table_042');
    expect(out).toContain('TABLE dbo.table_042');
    expect(out).toContain('id: int NOT NULL [PK]');
  });
});
