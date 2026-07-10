import { describe, expect, it } from 'vitest';
import { buildExplainStatement, buildSelectTemplate, defaultSchemaFor } from '../sql/templates.js';

describe('database SQL templates', () => {
  it('uses engine-correct bounded SELECT syntax', () => {
    expect(buildSelectTemplate('postgres', '"users"')).toBe('SELECT * FROM "users" LIMIT 100;');
    expect(buildSelectTemplate('mssql', '[dbo].[users]')).toBe('SELECT TOP (100) * FROM [dbo].[users];');
    expect(buildSelectTemplate('oracle', '"USERS"')).toBe('SELECT * FROM "USERS" FETCH FIRST 100 ROWS ONLY;');
  });

  it('uses engine-correct EXPLAIN syntax without enabling SQL Server SHOWPLAN', () => {
    expect(buildExplainStatement('postgres', 'SELECT 1')).toBe('EXPLAIN SELECT 1');
    expect(buildExplainStatement('sqlite', 'SELECT 1')).toBe('EXPLAIN QUERY PLAN SELECT 1');
    expect(buildExplainStatement('oracle', 'SELECT 1 FROM DUAL')).toBe('EXPLAIN PLAN FOR SELECT 1 FROM DUAL');
    expect(buildExplainStatement('mssql', 'SELECT 1')).toBeNull();
  });

  it('provides catalog defaults for PostgreSQL and SQL Server', () => {
    expect(defaultSchemaFor('postgres')).toBe('public');
    expect(defaultSchemaFor('mssql')).toBe('dbo');
    expect(defaultSchemaFor('mysql')).toBeUndefined();
  });
});
