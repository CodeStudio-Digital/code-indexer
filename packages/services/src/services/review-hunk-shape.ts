/**
 * Deterministic hunk-shape classifier for the snapshot_review payload.
 *
 * A unified diff charges the reviewer model the same token cost for a
 * formatting-only hunk and for a removed guard. Classifying each hunk's
 * SHAPE before rendering lets the payload spend its budget where bugs live:
 * mechanical hunks collapse to a one-line summary, logic hunks keep their
 * full body (see review-payload.ts).
 *
 * Pure text heuristics over Hunk lines — no AST, no LLM, no fs — and
 * deliberately conservative: anything not CLEARLY mechanical classifies as
 * `logic`, so a misclassification can only waste tokens, never hide a
 * behavioral change from the reviewer.
 */
import type { Hunk } from './snapshot-hunks.js';

export type HunkShape =
  | 'formatting_only'
  | 'import_only'
  | 'rename_mechanical'
  | 'config'
  | 'test'
  | 'logic';

export interface HunkClassification {
  shape: HunkShape;
  /** Present only for `rename_mechanical`: the consistent token substitution. */
  rename?: { from: string; to: string };
}

/** Shapes whose body may be elided to a one-line summary in the payload. */
export function isMechanicalShape(shape: HunkShape): boolean {
  return shape === 'formatting_only' || shape === 'import_only' || shape === 'rename_mechanical';
}

function changedLines(hunk: Pick<Hunk, 'lines'>): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of hunk.lines) {
    if (line.type === 'remove') removed.push(line.content);
    else if (line.type === 'add') added.push(line.content);
  }
  return { removed, added };
}

/**
 * Files where indentation/whitespace IS behavior — never classify their
 * changes as formatting (Python blocks, Makefile TAB recipes, YAML nesting…).
 */
const WHITESPACE_SENSITIVE_RE =
  /\.(py|pyw|yaml|yml|haml|slim|pug|jade|sass|styl|coffee|mk)$|(?:^|[\\/])(?:makefile|gnumakefile)$/i;

export function isWhitespaceSensitivePath(filePath: string): boolean {
  return WHITESPACE_SENSITIVE_RE.test(filePath.replace(/\\/g, '/'));
}

/**
 * Whitespace-only change, judged LINE BY LINE (conservative):
 *   - whitespace-sensitive files (Python/Makefile/YAML…) never qualify —
 *     indentation is behavior there;
 *   - both sides must have the same count of non-blank lines, so re-wraps
 *     (line-boundary moves — JS ASI semantics) never qualify;
 *   - a pair differing beyond indentation only qualifies when the line has
 *     NO string literal (whitespace inside quotes is behavioral) and the
 *     whitespace-stripped forms match (prettier-style `a=1` → `a = 1`).
 */
function isFormattingOnly(filePath: string, removed: string[], added: string[]): boolean {
  if (removed.length === 0 && added.length === 0) return false;
  if (isWhitespaceSensitivePath(filePath)) return false;
  const nonBlank = (lines: string[]): string[] =>
    lines.map((l) => l.trim()).filter((l) => l !== '');
  const a = nonBlank(removed);
  const b = nonBlank(added);
  // Pure blank-line churn.
  if (a.length === 0 && b.length === 0) return true;
  if (a.length !== b.length) return false;
  const hasQuote = (s: string): boolean => /['"`]/.test(s);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (hasQuote(a[i]) || hasQuote(b[i])) return false;
    if (a[i].replace(/\s+/g, '') !== b[i].replace(/\s+/g, '')) return false;
  }
  return true;
}

/**
 * Import-ish lines per language. Conservative: `export { x }` WITHOUT a
 * `from` clause changes the module surface and does not match.
 */
const IMPORT_RE = [
  /^\s*import\b/, // TS/JS (incl. `import type`, side-effect imports), Java, Python `import x`
  /^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\b/, // TS/JS re-exports
  /^\s*from\s+\S+\s+import\b/, // Python
  /^\s*(?:const|let|var)\s+[\w${},\s]+=\s*(?:await\s+)?(?:require|import)\s*\(/, // CJS/dynamic
  /^\s*use\s+[A-Za-z_\\][\w:\\]*(?:\s+as\s+\w+)?\s*;/, // PHP / Rust
  /^\s*(?:require|require_once|include|include_once)\s*[(\s]/, // PHP/Ruby
  /^\s*#include\b/, // C/C++
  /^\s*using\s+[\w.]+\s*;/, // C#
];

function isImportOnly(removed: string[], added: string[]): boolean {
  const lines = [...removed, ...added].filter((l) => l.trim() !== '');
  if (lines.length === 0) return false;
  return lines.every((l) => IMPORT_RE.some((re) => re.test(l)));
}

const TOKEN_RE = /[A-Za-z_$][\w$]*/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mechanical rename: removed/added pair line-by-line, every differing pair
 * differs by the SAME single identifier substitution, and replacing that
 * token on the removed side reproduces the added side exactly (catches
 * punctuation/string differences the token walk cannot see).
 *
 * A consistent substitution is NOT sufficient — swapping one call target
 * (`validate(x)` → `sanitize(x)`) looks identical to a rename. So a hunk
 * only classifies as rename when it also looks like one GLOBALLY:
 *   - at least two lines changed (a one-line "rename" is judged as logic);
 *   - the old token no longer exists ANYWHERE in the file's current content
 *     (a real rename removes it; a semantic swap usually leaves the old
 *     symbol alive elsewhere). No content available → not a rename.
 */
function detectRename(
  removed: string[],
  added: string[],
  currentContent: string | null | undefined,
): { from: string; to: string } | null {
  if (removed.length === 0 || removed.length !== added.length) return null;
  if (currentContent == null) return null;
  let from: string | null = null;
  let to: string | null = null;
  let changedPairs = 0;
  for (let i = 0; i < removed.length; i++) {
    if (removed[i] === added[i]) continue;
    changedPairs++;
    const rt = removed[i].match(TOKEN_RE) ?? [];
    const at = added[i].match(TOKEN_RE) ?? [];
    if (rt.length !== at.length) return null;
    for (let j = 0; j < rt.length; j++) {
      if (rt[j] === at[j]) continue;
      if (from == null) {
        from = rt[j];
        to = at[j];
      } else if (rt[j] !== from || at[j] !== to) {
        return null;
      }
    }
  }
  if (from == null || to == null || from === to || changedPairs < 2) return null;
  const re = new RegExp(`\\b${escapeRe(from)}\\b`, 'g');
  for (let i = 0; i < removed.length; i++) {
    if (removed[i].replace(re, to) !== added[i]) return null;
  }
  if (new RegExp(`\\b${escapeRe(from)}\\b`).test(currentContent)) return null;
  return { from, to };
}

const TEST_PATH_RE =
  /(?:^|[\\/])__tests__(?:[\\/]|$)|(?:^|[\\/])tests?[\\/]|[._-](?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb|php|rs)$|Test\.(?:java|kt|cs|php)$/;

const CONFIG_EXT = new Set([
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini',
  '.env', '.properties', '.lock', '.cfg', '.conf',
]);

export function isTestPath(filePath: string): boolean {
  return TEST_PATH_RE.test(filePath);
}

export function isConfigPath(filePath: string): boolean {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && CONFIG_EXT.has(base.slice(dot).toLowerCase())) return true;
  // Dotfiles with no real extension (.gitignore, .npmrc, .editorconfig, …).
  return dot === 0;
}

/**
 * Classify a single hunk. Shape detectors run before file-type buckets so a
 * formatting-only hunk in a test file still classifies as formatting.
 * `currentContent` (the file's on-disk content) is required for rename
 * detection — without it a consistent token swap stays `logic`.
 */
export function classifyHunk(
  filePath: string,
  hunk: Pick<Hunk, 'lines'>,
  currentContent?: string | null,
): HunkClassification {
  const { removed, added } = changedLines(hunk);
  if (isFormattingOnly(filePath, removed, added)) return { shape: 'formatting_only' };
  if (isImportOnly(removed, added)) return { shape: 'import_only' };
  const rename = detectRename(removed, added, currentContent);
  if (rename) return { shape: 'rename_mechanical', rename };
  if (isTestPath(filePath)) return { shape: 'test' };
  if (isConfigPath(filePath)) return { shape: 'config' };
  return { shape: 'logic' };
}
