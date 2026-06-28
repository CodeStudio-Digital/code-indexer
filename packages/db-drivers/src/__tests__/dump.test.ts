import { describe, it, expect } from 'vitest';
import { insertLiteral } from '../sql/dump.js';

describe('insertLiteral (dump serializer)', () => {
  const rows = [
    { id: 1, name: "O'Brien", active: true, score: 9.5, note: null, meta: { a: 1 } },
    { id: 2, name: 'Ada', active: false, score: 10, note: 'x', meta: null },
  ];
  const cols = ['id', 'name', 'active', 'score', 'note', 'meta'];

  it('postgres: double-quoted relation + columns, inline literals, one stmt/row', () => {
    const sql = insertLiteral('postgres', 'public', 't', cols, rows);
    const lines = sql.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `INSERT INTO "public"."t" ("id", "name", "active", "score", "note", "meta") VALUES (1, 'O''Brien', TRUE, 9.5, NULL, '{"a":1}');`,
    );
    expect(lines[1]).toBe(
      `INSERT INTO "public"."t" ("id", "name", "active", "score", "note", "meta") VALUES (2, 'Ada', FALSE, 10, 'x', NULL);`,
    );
  });

  it('mysql: backtick quoting', () => {
    const sql = insertLiteral('mysql', 'app', 't', ['id', 'name'], [{ id: 1, name: 'a' }]);
    expect(sql).toBe('INSERT INTO `app`.`t` (`id`, `name`) VALUES (1, \'a\');');
  });

  it('escapes single quotes and serializes objects/dates without stray double-quotes', () => {
    const sql = insertLiteral('postgres', undefined, 't', ['s', 'd'], [
      { s: "it's", d: new Date('2024-03-14T09:26:53.589Z') },
    ]);
    expect(sql).toBe(`INSERT INTO "t" ("s", "d") VALUES ('it''s', '2024-03-14T09:26:53.589Z');`);
    expect(sql).not.toContain('"2024-03-14'); // date not double-quoted
  });

  it('mysql/mariadb escapes backslashes (default string escaping) so restore round-trips', () => {
    const sql = insertLiteral('mysql', undefined, 't', ['p'], [{ p: 'a\\b' }]);
    expect(sql).toBe('INSERT INTO `t` (`p`) VALUES (\'a\\\\b\');');
    // postgres (standard strings) must NOT double the backslash
    expect(insertLiteral('postgres', undefined, 't', ['p'], [{ p: 'a\\b' }])).toBe(`INSERT INTO "t" ("p") VALUES ('a\\b');`);
  });

  it('booleans render as 1/0 for SQL Server + Oracle, TRUE/FALSE elsewhere', () => {
    expect(insertLiteral('mssql', 'dbo', 't', ['b'], [{ b: true }])).toBe('INSERT INTO [dbo].[t] ([b]) VALUES (1);');
    expect(insertLiteral('oracle', undefined, 't', ['b'], [{ b: false }])).toBe(`INSERT INTO "t" ("b") VALUES (0);`);
    expect(insertLiteral('postgres', undefined, 't', ['b'], [{ b: true }])).toBe(`INSERT INTO "t" ("b") VALUES (TRUE);`);
  });

  it('returns empty string for no rows (caller skips the chunk)', () => {
    expect(insertLiteral('sqlite', undefined, 't', ['id'], [])).toBe('');
  });
});
