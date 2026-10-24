import { describe, expect, it, vi } from 'vitest';
import type { DatabaseDriver, TableInfo, TableRef } from '@mcp/db-drivers/types.js';
import {
  DEFAULT_SCHEMA_PAGE_SIZE,
  defaultSchemaFromOptions,
  inspectRelationalSchema,
  inspectRelationalSchemaResult,
} from '../tools.js';

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
  it('never contacts a driver when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const { driver, listTables, describeTable } = fakeDriver();
    await expect(inspectRelationalSchemaResult(driver, {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(listTables).not.toHaveBeenCalled();
    expect(describeTable).not.toHaveBeenCalled();
  });

  it('stops waiting for a stalled catalog and ignores its late table result', async () => {
    const controller = new AbortController();
    const { driver, listTables, describeTable } = fakeDriver();
    let complete!: (refs: TableRef[]) => void;
    listTables.mockImplementation(() => new Promise<TableRef[]>(resolve => { complete = resolve; }));
    const pending = inspectRelationalSchemaResult(driver, { table: 'late' }, controller.signal);
    await Promise.resolve();
    expect(listTables).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    complete([{ schema: 'dbo', name: 'late', kind: 'table' }]);
    await Promise.resolve();
    expect(describeTable).not.toHaveBeenCalled();
  });

  it('cancels while expanding one table', async () => {
    const controller = new AbortController();
    const { driver, describeTable } = fakeDriver();
    describeTable.mockImplementation(async () => {
      controller.abort(); return new Promise<TableInfo>(() => {});
    });
    await expect(inspectRelationalSchemaResult(driver, { table: 'table_042' }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(describeTable).toHaveBeenCalledOnce();
  });
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

  it('declares catalog pagination as a recoverable producer cap', async () => {
    const { driver } = fakeDriver(500);
    const out = await inspectRelationalSchemaResult(driver, { offset: 40, limit: 40 });
    expect(out.sourceTruncations).toEqual([{
      technique: 'db-schema-page',
      inputSize: 500,
      outputSize: 40,
      unit: 'items',
      recoverable: true,
    }]);
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
