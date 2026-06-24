/**
 * Split a SQL buffer into individual statements on top-level `;`, respecting
 * single/double/backtick quoting (with doubled-quote escapes) and line/block
 * comments. Pure + dependency-free so it's trivially testable. Good enough for
 * the console's multi-statement runs across pg/mysql/sqlite (no procedural
 * `BEGIN…END` blocks — those run as one statement anyway via "run selection").
 */
type State = 'normal' | 'single' | 'double' | 'backtick' | 'line' | 'block';

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let state: State = 'normal';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    switch (state) {
      case 'normal':
        if (c === '-' && next === '-') {
          state = 'line';
          cur += c;
        } else if (c === '/' && next === '*') {
          state = 'block';
          cur += c + next;
          i += 2;
          continue;
        } else if (c === "'") {
          state = 'single';
          cur += c;
        } else if (c === '"') {
          state = 'double';
          cur += c;
        } else if (c === '`') {
          state = 'backtick';
          cur += c;
        } else if (c === ';') {
          out.push(cur);
          cur = '';
        } else {
          cur += c;
        }
        break;
      case 'line':
        cur += c;
        if (c === '\n') state = 'normal';
        break;
      case 'block':
        cur += c;
        if (c === '*' && next === '/') {
          cur += next;
          i += 2;
          state = 'normal';
          continue;
        }
        break;
      case 'single':
      case 'double':
      case 'backtick': {
        const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
        cur += c;
        if (c === quote) {
          if (next === quote) {
            cur += next; // doubled quote → escaped, stay in string
            i += 2;
            continue;
          }
          state = 'normal';
        }
        break;
      }
    }
    i++;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
