import { describe, expect, it } from 'vitest';
import {
  analyzeSqlForDisplay,
  maskSqlNoise,
  parseDbQueryInput,
  parseDbQueryResult,
  parseDbQueryResultMeta,
} from '../db-query-view.js';

describe('db_query visual model', () => {
  it('keeps the complete structured input for display', () => {
    expect(parseDbQueryInput({
      connection: 'Dellsoft',
      sql: 'SELECT * FROM dbo.socios WHERE id = @p0',
      params: [7],
      max_rows: 20,
    })).toEqual({
      connection: 'Dellsoft',
      sql: 'SELECT * FROM dbo.socios WHERE id = @p0',
      params: [7],
      maxRows: 20,
    });
  });

  it('classifies reads, writes, destructive statements and conservative batches', () => {
    expect(analyzeSqlForDisplay('SELECT * FROM users').risk).toBe('read');
    expect(analyzeSqlForDisplay('UPDATE users SET active = 0').risk).toBe('write');
    expect(analyzeSqlForDisplay('DROP TABLE users').risk).toBe('destructive');
    expect(analyzeSqlForDisplay("DECLARE @d date = '2026-07-31';\nSELECT 1")).toMatchObject({
      risk: 'review',
      operation: 'DECLARE',
      statementCount: 2,
    });
    expect(analyzeSqlForDisplay('SELECT * INTO users_copy FROM users')).toMatchObject({
      risk: 'write',
      flaggedKeywords: ['SELECT INTO'],
    });
  });

  it('does not treat keywords and semicolons inside comments or values as operations', () => {
    const masked = maskSqlNoise("SELECT 'DROP; DELETE' AS note -- UPDATE users\nFROM logs;");
    expect(masked).not.toMatch(/DROP|DELETE|UPDATE/);
    expect(analyzeSqlForDisplay("SELECT 'DROP; DELETE' AS note -- UPDATE users\nFROM logs;")).toMatchObject({
      risk: 'read',
      statementCount: 1,
    });
  });

  it('extracts row and truncation metadata from rendered db results', () => {
    expect(parseDbQueryResultMeta('id | name\n--- | ---\n1 | Ada\nrows=1 truncated=false')).toEqual({
      rows: 1,
      truncated: false,
    });
    expect(parseDbQueryResultMeta('failed')).toEqual({ rows: null, truncated: null });
  });

  it('detects Markdown tables and JSON while excluding the result metadata trailer', () => {
    expect(parseDbQueryResult('| id | name |\n| --- | --- |\n| 1 | Ada |\nrows=1 truncated=false')).toEqual({
      kind: 'markdown',
      body: '| id | name |\n| --- | --- |\n| 1 | Ada |',
      pretty: null,
    });
    expect(parseDbQueryResult('{"id":1}')).toEqual({
      kind: 'json',
      body: '{"id":1}',
      pretty: '{\n  "id": 1\n}',
    });
    expect(parseDbQueryResult('rows=1 truncated=false')).toMatchObject({ kind: 'text', body: '' });
  });
});
