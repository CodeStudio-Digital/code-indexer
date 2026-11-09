import { describe, it, expect } from 'vitest';
import { stripSqlNoise, hasMultipleStatements, WRITE_KW, isReadStatement } from '../sql/read-guard.js';

/**
 * Behavior lock for the read-only SQL valve (moved verbatim from the dbClient
 * handlers). Asserts document the REAL classifier: conservative by design —
 * some harmless statements (SHOW CREATE, PRAGMA) are rejected under read-only.
 */

describe('isReadStatement', () => {
  it.each([
    "SELECT '--'; DELETE FROM audit_fixture",
    "SELECT '/*'; DELETE FROM audit_fixture; SELECT '*/'",
    'SELECT 1--2; DELETE FROM audit_fixture',
    'SELECT 1 /*!; DELETE FROM audit_fixture */',
    'SELECT 1 /*M!; DELETE FROM audit_fixture */',
    "SELECT 'unterminated",
    'SELECT 1 /* unterminated',
    'SELECT 1 /* outer /* inner */ ; DELETE FROM audit_fixture */',
  ])('rejects ambiguous or mutating SQL before dispatch: %s', (sql) => {
    expect(isReadStatement(sql)).toBe(false);
  });

  it.each(["SELECT '--'", "SELECT '/*'", "SELECT '*/'", 'SELECT $$hello world$$', 'SELECT [delete] FROM t'])('recognizes literal boundaries: %s', (sql) => {
    expect(isReadStatement(sql)).toBe(true);
    expect(hasMultipleStatements(sql)).toBe(false);
  });

  it('does not hide statement separators following comment-shaped strings', () => {
    expect(hasMultipleStatements("SELECT '--'; DELETE FROM audit_fixture")).toBe(true);
    expect(hasMultipleStatements("SELECT '/*'; DELETE FROM audit_fixture; SELECT '*/'")).toBe(true);
  });

  it('does not let a dollar-quoted region hide a statement from dialects without dollar quoting', () => {
    // PostgreSQL reads `a$$` as part of an identifier; MySQL, SQLite and SQL Server
    // have no dollar quoting at all. Without a negotiated dialect, `$$…$$` must not
    // hide a separator, a quote or a comment marker from those engines.
    for (const sql of [
      'SELECT 1 AS a$$; DELETE FROM audit_fixture; SELECT 1 AS b$$',
      'SELECT $$; DELETE FROM audit_fixture; SELECT $$',
      "SELECT $$'; -- DELETE$$",
    ]) {
      expect(isReadStatement(sql), sql).toBe(false);
      expect(hasMultipleStatements(sql), sql).toBe(true);
    }
  });

  it('treats a MySQL # line comment as a comment when admitting reads', () => {
    // `#` starts a comment on MySQL/MariaDB, so the text after it is real SQL there.
    expect(isReadStatement("SELECT * FROM users # '\n INTO OUTFILE '/tmp/x' -- '")).toBe(false);
    const hiddenStatement = "SELECT 1 # '\n; DELETE FROM audit_fixture -- '";
    expect(isReadStatement(hiddenStatement)).toBe(false);
    expect(hasMultipleStatements(hiddenStatement)).toBe(true);
    // A `#` that is only an operator or a SQL Server temp-table name stays a read.
    expect(isReadStatement('SELECT 5 # 3')).toBe(true);
    expect(isReadStatement('SELECT * FROM #recent_orders')).toBe(true);
  });
  it('accepts plain reads', () => {
    expect(isReadStatement('SELECT * FROM users')).toBe(true);
    expect(isReadStatement('select 1')).toBe(true);
    expect(isReadStatement('SELECT 1;')).toBe(true); // single trailing ; is fine
    expect(isReadStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isReadStatement('SHOW TABLES')).toBe(true);
    expect(isReadStatement('DESCRIBE users')).toBe(true);
    expect(isReadStatement('DESC users')).toBe(true);
  });

  it('rejects a CTE with an embedded write', () => {
    expect(isReadStatement('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x')).toBe(false);
    expect(isReadStatement('WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x')).toBe(false);
  });

  it('rejects read-shaped statements that create, export, lock, or mutate state', () => {
    // SQL Server/Postgres table creation; MySQL server-side file export.
    expect(isReadStatement('SELECT * INTO archived_users FROM users')).toBe(false);
    expect(isReadStatement(`SELECT * FROM users INTO OUTFILE '/tmp/users.csv'`)).toBe(false);
    expect(isReadStatement('WITH x AS (SELECT 1) SELECT * INTO copied FROM x')).toBe(false);
    // Locks and sequence state are writes/side effects for a strict read-only connection.
    expect(isReadStatement('SELECT * FROM users FOR UPDATE')).toBe(false);
    expect(isReadStatement('SELECT * FROM users LOCK IN SHARE MODE')).toBe(false);
    expect(isReadStatement('SELECT NEXT VALUE FOR order_seq')).toBe(false);
    expect(isReadStatement(`SELECT nextval('order_seq')`)).toBe(false);
    expect(isReadStatement(`SELECT setval('order_seq', 42)`)).toBe(false);
    expect(isReadStatement(`SELECT dblink_exec('DELETE FROM users')`)).toBe(false);
  });

  it('EXPLAIN ANALYZE executes the statement → write; bare EXPLAIN is a read', () => {
    expect(isReadStatement('EXPLAIN ANALYZE SELECT * FROM t')).toBe(false);
    expect(isReadStatement('EXPLAIN SELECT * FROM t')).toBe(true);
    expect(isReadStatement('EXPLAIN QUERY PLAN SELECT 1')).toBe(true); // sqlite form
    expect(isReadStatement('EXPLAIN DELETE FROM t')).toBe(false); // embedded write kw
  });

  it('rejects multi-statement buffers', () => {
    expect(isReadStatement('SELECT 1; DROP TABLE x')).toBe(false);
    expect(isReadStatement('SELECT 1; SELECT 2')).toBe(false); // even two reads
  });

  it('keywords inside strings/comments do not flip the verdict', () => {
    expect(isReadStatement(`SELECT 'DELETE' AS action`)).toBe(true);
    expect(isReadStatement('SELECT 1 -- DROP TABLE x')).toBe(true);
    expect(isReadStatement('/* UPDATE t */ SELECT 1')).toBe(true);
    expect(isReadStatement(`SELECT "insert" FROM t`)).toBe(true); // quoted identifier
  });

  it('rejects plain writes and empty input', () => {
    expect(isReadStatement('UPDATE t SET x = 1')).toBe(false);
    expect(isReadStatement('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isReadStatement('DROP TABLE t')).toBe(false);
    expect(isReadStatement('')).toBe(false);
    expect(isReadStatement('   ')).toBe(false);
    expect(isReadStatement('-- only a comment')).toBe(false);
  });

  it('is conservative: benign-but-writing-looking statements are rejected', () => {
    // WRITE_KW matches `create` anywhere → SHOW CREATE TABLE is (safely) blocked.
    expect(isReadStatement('SHOW CREATE TABLE users')).toBe(false);
    // PRAGMA is not in the read-verb allowlist → treated as a write.
    expect(isReadStatement('PRAGMA table_info(users)')).toBe(false);
  });
});

describe('hasMultipleStatements', () => {
  it('detects a second top-level statement', () => {
    expect(hasMultipleStatements('SELECT 1; DROP TABLE x')).toBe(true);
    expect(hasMultipleStatements('SELECT 1;\nSELECT 2;')).toBe(true);
  });

  it('ignores trailing semicolons and `;` inside strings/comments', () => {
    expect(hasMultipleStatements('SELECT 1')).toBe(false);
    expect(hasMultipleStatements('SELECT 1;')).toBe(false);
    expect(hasMultipleStatements('SELECT 1;;  ')).toBe(false);
    expect(hasMultipleStatements(`SELECT ';' AS semi`)).toBe(false);
    expect(hasMultipleStatements('SELECT 1 -- ; not a statement')).toBe(false);
  });
});

describe('stripSqlNoise', () => {
  it('collapses literals (incl. escaped quotes) and strips comments', () => {
    expect(stripSqlNoise(`SELECT 'it''s; a trap'`)).toBe(`SELECT ''`);
    expect(stripSqlNoise('SELECT 1 -- tail comment')).toBe('SELECT 1  ');
    expect(stripSqlNoise('/* block */ SELECT 1')).toBe('  SELECT 1');
    expect(stripSqlNoise('SELECT `a``b` FROM t')).toBe('SELECT `` FROM t');
  });
});

describe('WRITE_KW', () => {
  it('matches write verbs on word boundaries only', () => {
    expect(WRITE_KW.test('DELETE FROM t')).toBe(true);
    expect(WRITE_KW.test('lowercase update too')).toBe(true);
    expect(WRITE_KW.test('SELECT selected, recalled FROM t')).toBe(false); // no substring hits
  });
});
