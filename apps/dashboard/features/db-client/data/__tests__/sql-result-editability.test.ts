import { describe, expect, it } from 'vitest';
import { analyzeSqlResultEditability } from '../sql-result-editability.js';
import type { DbQueryResult } from '../../types.js';

const result = (columns: string[]): DbQueryResult => ({
  rows: columns.length ? [Object.fromEntries(columns.map((column) => [column, 1]))] : [],
  rowCount: columns.length ? 1 : 0,
  fields: columns.map((name) => ({ name })),
});

function analyze(sql: string, columns = ['id', 'name', 'tenant_id']) {
  return analyzeSqlResultEditability({
    sql,
    schema: 'dbo',
    table: 'users',
    primaryKeyColumns: ['id'],
    tableColumns: ['id', 'name', 'tenant_id'],
    result: result(columns),
  });
}

describe('custom SQL result editability', () => {
  it('enables inline editing for a simple full-table SELECT', () => {
    expect(analyze('SELECT * FROM users WHERE tenant_id = 1 ORDER BY id')).toMatchObject({
      singleTable: true,
      completeRow: true,
      editable: true,
    });
  });

  it('supports qualified and quoted identifiers plus SQL Server TOP', () => {
    expect(analyze('SELECT TOP (50) [id], [name], [tenant_id] FROM [dbo].[users] AS u')).toMatchObject({
      singleTable: true,
      completeRow: true,
      editable: true,
    });
  });

  it('allows a physical-column projection when the PK remains present', () => {
    expect(analyze('SELECT id, name FROM users', ['id', 'name'])).toMatchObject({
      singleTable: true,
      completeRow: false,
      editable: true,
    });
  });

  it('keeps joins, aggregates, aliases and other tables read-only', () => {
    expect(analyze('SELECT * FROM users u JOIN roles r ON r.id = u.role_id').editable).toBe(false);
    expect(analyze('SELECT COUNT(*) AS total FROM users', ['total']).editable).toBe(false);
    expect(analyze('SELECT id AS user_id, name FROM users', ['user_id', 'name']).editable).toBe(false);
    expect(analyze('SELECT * FROM audit_users').editable).toBe(false);
  });

  it('requires the primary key in the result', () => {
    expect(analyze('SELECT name, tenant_id FROM users', ['name', 'tenant_id'])).toMatchObject({
      singleTable: true,
      editable: false,
      reason: 'missing-primary-key',
    });
  });

  it('rejects multiple statements and nested selects', () => {
    expect(analyze('SELECT * FROM users; SELECT * FROM users').editable).toBe(false);
    expect(analyze('SELECT * FROM users WHERE id IN (SELECT user_id FROM audit)').editable).toBe(false);
  });
});
