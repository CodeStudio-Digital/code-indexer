/**
 * tokenizeShell — split a curl/bash command into argv tokens. Handles line
 * continuations (\ and ^), single quotes (literal), double quotes (with \" \\ \$
 * escapes), ANSI-C $'...' (\n \t \r \\ \' \xNN), and adjacent-token concatenation
 * (shell glues "a"b'c' into abc). Pure.
 */
export function tokenizeShell(input: string): string[] {
  // Join continuations first so the scanner sees one logical line.
  const src = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const tokens: string[] = [];
  let cur = '';
  let has = false; // current token has content (even if empty-quoted)
  let i = 0;

  const push = (): void => { if (has) { tokens.push(cur); cur = ''; has = false; } };

  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { push(); i++; continue; }
    has = true;
    if (ch === "'") {
      i++;
      while (i < src.length && src[i] !== "'") cur += src[i++];
      i++; // closing '
    } else if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) { cur += src[i + 1]; i += 2; }
        else cur += src[i++];
      }
      i++; // closing "
    } else if (ch === '$' && src[i + 1] === "'") {
      i += 2;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\') { const [str, adv] = ansiEscape(src, i); cur += str; i += adv; }
        else cur += src[i++];
      }
      i++; // closing '
    } else if (ch === '\\') {
      if (i + 1 < src.length) { cur += src[i + 1]; i += 2; } else i++;
    } else {
      cur += ch; i++;
    }
  }
  push();
  return tokens;
}

function ansiEscape(s: string, i: number): [string, number] {
  const c = s[i + 1];
  switch (c) {
    case 'n': return ['\n', 2];
    case 't': return ['\t', 2];
    case 'r': return ['\r', 2];
    case '\\': return ['\\', 2];
    case "'": return ["'", 2];
    case '"': return ['"', 2];
    case 'x': {
      const hex = s.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/)?.[0];
      if (hex) return [String.fromCharCode(parseInt(hex, 16)), 2 + hex.length];
      return ['x', 2];
    }
    default: return [c ?? '', 2];
  }
}
