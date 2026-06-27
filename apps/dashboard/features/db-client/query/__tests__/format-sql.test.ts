import { describe, it, expect } from 'vitest';
import { formatSql } from '../format-sql.js';

describe('formatSql', () => {
  it('upper-cases keywords and breaks major clauses', () => {
    const out = formatSql('select a, b from users where x=1 and y=2 order by a');
    expect(out).toBe('SELECT a,\n  b\nFROM users\nWHERE x = 1\n  AND y = 2\nORDER BY a');
  });

  it('keeps multi-word clauses together (LEFT JOIN, GROUP BY, UNION ALL)', () => {
    const out = formatSql('select * from a left join b on a.id=b.a_id group by a.id');
    expect(out).toContain('LEFT JOIN b');
    expect(out).toContain('\n  ON a.id = b.a_id');
    expect(out).toContain('\nGROUP BY a.id');
    expect(out).not.toContain('LEFT\n');
  });

  it('preserves string literals and comments verbatim (no keyword casing inside)', () => {
    const out = formatSql("select 'from where' /* select */ , x from t");
    expect(out).toContain("'from where'");
    expect(out).toContain('/* select */');
  });

  it('splits multiple statements onto their own lines', () => {
    const out = formatSql('select 1; select 2');
    expect(out.split('\n').filter((l) => l.trim().startsWith('SELECT')).length).toBe(2);
  });
});
