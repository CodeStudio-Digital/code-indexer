/**
 * Pure path matcher for terminal output → clickable editor links (quick win,
 * mirrors JetBrains' terminal file filter). Matches PROJECT-RELATIVE paths
 * ending in a file extension, optionally followed by `:line` or `:line:col`
 * (the tsc/vitest/eslint-relative convention). Absolute paths (Windows `C:\`,
 * POSIX `/…`, WSL `/mnt/…`) are intentionally skipped in v1 — they need the
 * project root to relativize, which the renderer doesn't carry here.
 *
 * Kept separate + pure so the character-offset math is unit-tested without
 * xterm. Offsets are 0-based half-open [startX, endX) into the source line.
 */

export interface TerminalPathMatch {
  /** 0-based start index of the whole token (path + optional :line:col) in the line. */
  startX: number;
  /** 0-based end index (exclusive). */
  endX: number;
  /** Project-relative, forward-slash path (no location suffix). */
  path: string;
  line?: number;
  column?: number;
}

// A relative token: optional `./`|`../`, path segments joined by `/` or `\`,
// ending in `.<ext>`, with an optional `:line(:col)?` location. Drive letters
// and leading slashes are excluded by the regex + the preceding-char guard.
const TOKEN_RE = /(?:\.{1,2}[\\/])?(?:[\w.\-]+[\\/])+[\w.\-]+\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?)?|[\w.\-]+\.[A-Za-z][A-Za-z0-9]{0,9}:\d+(?::\d+)?/g;
const MAX_TOKEN_LEN = 512;

export function findTerminalPathMatches(line: string): TerminalPathMatch[] {
  const out: TerminalPathMatch[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    const token = m[0];
    if (token.length > MAX_TOKEN_LEN) continue;
    // Preceded by a separator/colon → part of an absolute or longer path; skip.
    const prev = m.index > 0 ? line[m.index - 1]! : '';
    if (prev === '/' || prev === '\\' || prev === ':') continue;

    // Split the optional `:line:col` (a relative path has no other ':').
    const parts = token.split(':');
    const rawPath = parts[0]!;
    const line1 = parts.length >= 2 && /^\d+$/.test(parts[1]!) ? Number(parts[1]) : undefined;
    const column = parts.length >= 3 && /^\d+$/.test(parts[2]!) ? Number(parts[2]) : undefined;

    const path = rawPath.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
    // Require a directory separator OR an explicit location, so bare mentions
    // like "config.js" in prose don't become links.
    if (!path.includes('/') && line1 === undefined) continue;

    out.push({
      startX: m.index,
      endX: m.index + token.length,
      path,
      ...(line1 !== undefined ? { line: line1 } : {}),
      ...(column !== undefined ? { column } : {}),
    });
  }
  return out;
}
