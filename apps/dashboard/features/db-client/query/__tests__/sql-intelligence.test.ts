import { describe, expect, it } from 'vitest';
import {
  analyzeSql,
  bindNamedParameters,
  completionContext,
  extractTableReferences,
  findNamedParameters,
  maskSql,
  parseParameterValue,
} from '../sql-intelligence.js';

describe('sql intelligence', () => {
  it('masks strings/comments without changing offsets and extracts aliases', () => {
    const sql = "SELECT ':ignored' FROM public.users u JOIN orders o ON o.user_id = u.id -- :nope";
    expect(maskSql(sql)).toHaveLength(sql.length);
    expect(extractTableReferences(sql)).toEqual([
      { schema: 'public', table: 'users', alias: 'u' },
      { table: 'orders', alias: 'o' },
    ]);
  });

  it('classifies completion context', () => {
    expect(completionContext('SELECT * FROM us', 16)).toBe('table');
    expect(completionContext('SELECT u. FROM users u', 9)).toBe('column');
  });

  it('binds repeated named parameters with engine placeholders', () => {
    const sql = 'SELECT * FROM users WHERE id = :id OR owner_id = :id AND note = :note::text';
    expect(findNamedParameters(sql)).toEqual(['id', 'note']);
    expect(bindNamedParameters(sql, { id: 7, note: 'ok' }, 'postgres')).toEqual({
      sql: 'SELECT * FROM users WHERE id = $1 OR owner_id = $2 AND note = $3::text',
      params: [7, 7, 'ok'],
    });
  });

  it('parses useful parameter literals', () => {
    expect(parseParameterValue('null')).toBeNull();
    expect(parseParameterValue('42')).toBe(42);
    expect(parseParameterValue('true')).toBe(true);
    expect(parseParameterValue('{"ok":1}')).toEqual({ ok: 1 });
  });

  it('reports unsafe writes, destructive DDL, joins and unresolved relations', () => {
    const diagnostics = analyzeSql('UPDATE users SET active = 0; DROP TABLE audit; SELECT * FROM missing JOIN roles', ['users']);
    expect(diagnostics.map((item) => item.code)).toEqual([
      'write-without-where',
      'destructive-ddl',
      'join-without-on',
      'unresolved-table',
      'unresolved-table',
    ]);
  });
});
