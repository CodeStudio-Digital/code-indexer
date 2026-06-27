/**
 * Tiny dependency-free SQL pretty-printer for the console's "Format" action.
 * Tokenizes (preserving strings + comments verbatim), upper-cases keywords, and
 * breaks before the major clauses. It is intentionally conservative — a useful
 * tidy-up, not a full SQL re-flow — so it never reorders or drops anything.
 */

// Keywords we upper-case.
const KEYWORDS = new Set(
  (
    'select from where group by order having limit offset union all insert into values update set delete create table alter add drop column ' +
    'join inner left right full cross outer on and or not null is in like between exists as case when then else end distinct asc desc ' +
    'primary key foreign references default unique index returning using with recursive having count sum avg min max coalesce cast'
  ).split(' '),
);

// Break to a new line (column 0) before these lead words.
const NL_TOP = new Set(['select', 'from', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'values', 'set', 'returning', 'insert', 'update', 'delete']);
// Break to a new indented line before these.
const NL_INDENT = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'and', 'or', 'on']);
// When the previous word is one of these, the next keyword continues the same
// clause (e.g. LEFT • JOIN, GROUP • BY, UNION • ALL) — don't break.
const CONTINUES = new Set(['left', 'right', 'inner', 'full', 'cross', 'outer', 'union', 'group', 'order', 'insert', 'delete']);

interface Tok {
  t: 'str' | 'comment' | 'word' | 'num' | 'ws' | 'punct';
  v: string;
}

function tokenize(sql: string): Tok[] {
  const re = /('(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`)|(--[^\n]*|\/\*[\s\S]*?\*\/)|([A-Za-z_][A-Za-z0-9_$]*)|(\d+(?:\.\d+)?)|(\s+)|(.)/g;
  const out: Tok[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    if (m[1] != null) out.push({ t: 'str', v: m[1] });
    else if (m[2] != null) out.push({ t: 'comment', v: m[2] });
    else if (m[3] != null) out.push({ t: 'word', v: m[3] });
    else if (m[4] != null) out.push({ t: 'num', v: m[4] });
    else if (m[5] != null) out.push({ t: 'ws', v: m[5] });
    else out.push({ t: 'punct', v: m[6] });
  }
  return out;
}

export function formatSql(sql: string): string {
  const toks = tokenize(sql).filter((t) => t.t !== 'ws');
  let out = '';
  let prevWord = '';
  let needSpace = false;
  let depth = 0;

  const append = (s: string): void => {
    out += s;
  };

  for (const tok of toks) {
    if (tok.t === 'punct') {
      if (tok.v === ',') {
        // Break the top-level list (SELECT / GROUP BY) one item per line; keep
        // commas inside parens (function args, VALUES) on one line.
        if (depth === 0) {
          append(',\n  ');
          needSpace = false;
        } else {
          append(',');
          needSpace = true;
        }
        continue;
      }
      if (tok.v === '(') {
        if (needSpace) append(' ');
        append('(');
        needSpace = false;
        depth += 1;
        continue;
      }
      if (tok.v === ')') {
        append(')');
        needSpace = true;
        if (depth > 0) depth -= 1;
        continue;
      }
      if (tok.v === ';') {
        append(';\n');
        needSpace = false;
        prevWord = '';
        continue;
      }
      if (tok.v === '.') {
        // Qualified name (a.b) — glue, no surrounding spaces.
        append('.');
        needSpace = false;
        prevWord = '';
        continue;
      }
      // operators / other punctuation → spaced
      if (needSpace) append(' ');
      append(tok.v);
      needSpace = true;
      continue;
    }

    const lw = tok.t === 'word' ? tok.v.toLowerCase() : '';
    const isKw = KEYWORDS.has(lw);
    const value = isKw ? tok.v.toUpperCase() : tok.v;
    const isBreak = tok.t === 'word' && (NL_TOP.has(lw) || NL_INDENT.has(lw)) && !CONTINUES.has(prevWord) && out.trim() !== '';

    if (isBreak) {
      append(out.endsWith('\n') ? '' : '\n');
      if (NL_INDENT.has(lw)) append('  ');
      append(value);
    } else {
      if (needSpace && !out.endsWith('\n') && out !== '') append(' ');
      append(value);
    }
    needSpace = true;
    if (tok.t === 'word') prevWord = lw;
    else prevWord = '';
  }

  return out.trim();
}
