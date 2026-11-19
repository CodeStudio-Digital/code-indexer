/**
 * Line-based hunk location for `apply_patch`, following Codex `seek_sequence`:
 * exact → trailing whitespace → surrounding whitespace → Unicode punctuation.
 *
 * GPT models learned the patch format against those fuzz levels. A strict
 * substring match turned a one-tab indentation slip into a rejected patch
 * and three recovery rounds (inspect, re-read, regenerate). Fuzzy matches
 * keep the file's own context lines and re-indent added lines by the delta
 * observed between the patch and the file, so a slip does not leak into the
 * written code.
 */

export type MatchLevel = 'exact' | 'rstrip' | 'trim' | 'unicode';
const LEVELS: readonly MatchLevel[] = ['exact', 'rstrip', 'trim', 'unicode'];

export interface HunkLine { kind: 'context' | 'remove' | 'add'; text: string }
export interface LocatedHunk { start: number; level: MatchLevel }

const PUNCTUATION = /[‐-―−‘-‟  -   　]/g;

function asciiPunctuation(char: string): string {
  const code = char.charCodeAt(0);
  if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) return '-';
  if (code >= 0x2018 && code <= 0x201b) return '\'';
  if (code >= 0x201c && code <= 0x201f) return '"';
  return ' ';
}

function keyFor(level: MatchLevel, line: string): string {
  if (level === 'exact') return line;
  if (level === 'rstrip') return line.trimEnd();
  if (level === 'trim') return line.trim();
  return line.trim().replace(PUNCTUATION, asciiPunctuation);
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * Locate `pattern` in `lines`. Regions are tried in order — after the `@@`
 * anchor line (when present and found), from the cursor, from the top — and
 * within a region the strictest level wins. Returns null when nothing matches.
 */
export function locateHunk(
  lines: readonly string[],
  pattern: readonly string[],
  cursor: number,
  anchor?: string,
): LocatedHunk | null {
  if (pattern.length === 0 || pattern.length > lines.length) return null;
  const cache = new Map<MatchLevel, string[]>();
  const keyed = (level: MatchLevel): string[] => {
    let keys = cache.get(level);
    if (!keys) { keys = lines.map((line) => keyFor(level, line)); cache.set(level, keys); }
    return keys;
  };
  const seek = (from: number, level: MatchLevel): number => {
    const keys = keyed(level);
    const wanted = pattern.map((line) => keyFor(level, line));
    outer: for (let i = Math.max(0, from); i <= lines.length - wanted.length; i++) {
      for (let k = 0; k < wanted.length; k++) if (keys[i + k] !== wanted[k]) continue outer;
      return i;
    }
    return -1;
  };
  const starts: number[] = [];
  const anchorAt = anchor ? findAnchor(lines, anchor, cursor) : -1;
  if (anchorAt >= 0) starts.push(anchorAt + 1);
  starts.push(Math.min(Math.max(0, cursor), lines.length), 0);
  for (const from of [...new Set(starts)]) {
    for (const level of LEVELS) {
      const start = seek(from, level);
      if (start >= 0) return { start, level };
    }
  }
  return null;
}

/** Anchor line from `@@ <text>`: equal after trimming, else containing it. */
function findAnchor(lines: readonly string[], anchor: string, cursor: number): number {
  const wanted = keyFor('unicode', anchor);
  if (!wanted) return -1;
  const order = [...lines.keys()].slice(cursor).concat([...lines.keys()].slice(0, cursor));
  for (const i of order) if (keyFor('unicode', lines[i]) === wanted) return i;
  if (wanted.length < 3) return -1;
  for (const i of order) if (keyFor('unicode', lines[i]).includes(wanted)) return i;
  return -1;
}

/**
 * Replacement lines for a located hunk: context lines come from the file
 * (never from the patch), removed lines are dropped, added lines are
 * re-indented when the match tolerated leading-whitespace differences.
 */
export function buildReplacement(
  lines: readonly string[],
  start: number,
  ops: readonly HunkLine[],
  level: MatchLevel,
): string[] {
  const pairs: Array<[string, string]> = [];
  let cursor = start;
  for (const op of ops) if (op.kind !== 'add') pairs.push([op.text, lines[cursor++]]);
  const reindent = level === 'trim' || level === 'unicode' ? indentMapper(pairs) : (line: string) => line;
  const out: string[] = [];
  cursor = start;
  for (const op of ops) {
    if (op.kind === 'context') out.push(lines[cursor++]);
    else if (op.kind === 'remove') cursor++;
    else out.push(reindent(op.text));
  }
  return out;
}

/**
 * Infer one consistent indentation rewrite (patch prefix P → file prefix F)
 * from matched non-blank pairs; inconsistent evidence leaves lines untouched.
 */
export function indentMapper(pairs: ReadonlyArray<readonly [string, string]>): (line: string) => string {
  const identity = (line: string): string => line;
  const evidence = pairs.filter(([patch, file]) => patch.trim() && file.trim());
  if (evidence.length === 0) return identity;
  let base = evidence[0];
  for (const pair of evidence) {
    if (leadingWhitespace(pair[0]).length < leadingWhitespace(base[0]).length) base = pair;
  }
  const from = leadingWhitespace(base[0]);
  const to = leadingWhitespace(base[1]);
  for (const [patch, file] of evidence) {
    const patchIndent = leadingWhitespace(patch);
    if (!patchIndent.startsWith(from) || leadingWhitespace(file) !== to + patchIndent.slice(from.length)) {
      return identity;
    }
  }
  if (from === to) return identity;
  const unitChars = new Set(from + to);
  const unit = unitChars.size === 1 ? [...unitChars][0] : null;
  return (line: string): string => {
    if (!line.trim()) return line;
    const indent = leadingWhitespace(line);
    const body = line.slice(indent.length);
    if (indent.startsWith(from)) return to + indent.slice(from.length) + body;
    if (unit && [...indent].every((char) => char === unit)) {
      return unit.repeat(Math.max(0, indent.length + to.length - from.length)) + body;
    }
    return line;
  };
}

const MAX_SCORED_PATTERN_LINES = 60;
const MAX_EXCERPT_LINES = 14;
const MAX_EXCERPT_CHARS = 4600;

function tokens(line: string): Set<string> {
  return new Set(line.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []);
}

function similarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

function differenceWindow(line: string, at: number): string {
  if (line.length <= 120) return JSON.stringify(line);
  const start = Math.max(0, at - 45);
  const end = Math.min(line.length, at + 55);
  return JSON.stringify((start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : ''));
}

/** Where the hunk most likely belonged, with current text, for the error. */
export function describeClosestRegion(lines: readonly string[], pattern: readonly string[], label = 'patch'): string {
  if (pattern.length === 0 || lines.length === 0) return '';
  const scored = pattern.slice(0, MAX_SCORED_PATTERN_LINES).map((line) => line.trim());
  const trimmed = lines.map((line) => line.trim());
  let bestStart = -1;
  let bestScore = 0;
  let bestWeight = 0;
  for (let i = 0; i < trimmed.length; i++) {
    let score = 0;
    let weight = 0;
    for (let k = 0; k < scored.length && i + k < trimmed.length; k++) {
      if (!scored[k] || trimmed[i + k] !== scored[k]) continue;
      score++;
      // A shared brace is weak evidence compared with a shared declaration.
      if (scored[k].length > 2) weight += Math.min(scored[k].length, 120);
    }
    if (weight > bestWeight || (weight > 0 && weight === bestWeight && score > bestScore)) {
      bestWeight = weight;
      bestScore = score;
      bestStart = i;
    }
  }
  if (bestStart < 0) {
    const probe = scored.reduce((longest, line) => line.length > longest.length ? line : longest, '');
    const probeTokens = tokens(probe);
    const probeIndex = scored.indexOf(probe);
    let bestSimilarity = 0.4;
    lines.forEach((line, i) => {
      const value = similarity(probeTokens, tokens(line));
      if (value > bestSimilarity) { bestSimilarity = value; bestStart = Math.max(0, i - probeIndex); }
    });
  }
  if (bestStart < 0) return '  No nearby match in the current file. Locate the target by symbol or search before retrying.\n';
  const from = Math.max(0, bestStart - 1);
  const to = Math.min(lines.length, bestStart + Math.min(pattern.length, MAX_EXCERPT_LINES) + 1);
  const excerpt = lines.slice(from, to).map((line, i) => {
    const text = line.length > 800 ? `${line.slice(0, 800)}…` : line;
    return `    ${from + i + 1}\t${text}`;
  }).join('\n');
  const boundedExcerpt = excerpt.length > MAX_EXCERPT_CHARS ? `${excerpt.slice(0, MAX_EXCERPT_CHARS)}\n    …` : excerpt;
  let difference = '';
  for (let k = 0; k < pattern.length && bestStart + k < lines.length; k++) {
    const expected = pattern[k];
    const current = lines[bestStart + k];
    if (expected === current) continue;
    let at = 0;
    while (at < Math.min(expected.length, current.length) && expected[at] === current[at]) at++;
    difference = `  First difference: ${label} line ${k + 1} is ${differenceWindow(expected, at)} but file line ${bestStart + k + 1} is ${differenceWindow(current, at)}.\n`;
    break;
  }
  return `  Closest region: lines ${bestStart + 1}-${Math.min(lines.length, bestStart + pattern.length)} ` +
    `(${bestScore}/${pattern.length} ${label} lines equal ignoring indentation).\n${difference}  Current text:\n${boundedExcerpt}\n`;
}
