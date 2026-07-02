/**
 * Deterministic request suppression for AI completion — Copilot's contextual
 * filter, minus the ML: cheap rules over the cursor line that skip positions
 * where a completion is near-certain to be useless (each skipped request
 * saves a debounce wait + provider call). Pure string work: lives in
 * @mcp/shared so the dashboard (not tsc-checked) gets a type-checked,
 * unit-tested implementation.
 */

export type Suppression = 'strict' | 'standard' | 'lenient';

export interface PrefilterCtx {
  /** Cursor line text BEFORE the cursor. */
  lineBefore: string;
  /** Cursor line text AFTER the cursor. */
  lineAfter: string;
  languageId: string;
  /** Total trimmed length of the prefix window (near-empty-buffer rule). */
  prefixTotalTrimmedLen: number;
  suppression: Suppression;
}

export interface PrefilterVerdict {
  skip: boolean;
  /** Rule id for telemetry ('r1'…'r6'). */
  rule?: string;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
/** R1: statement enders — nothing left to complete at EOL after these. */
const ENDERS_ALL = new Set([';', '}', ')', ']']);
const ENDERS_STRICT = new Set([';', '}', ')', ']', '{', ',']);
const COMMENT_MARKER = /(?:\/\/|#|--)(?!.*['"`])/;
const IMPORT_LINE = /^\s*(?:import|from|use|require|include|#include)\b/;

const NO_SKIP: PrefilterVerdict = { skip: false };

export function shouldSkipCompletion(ctx: PrefilterCtx): PrefilterVerdict {
  const { lineBefore, lineAfter, suppression } = ctx;
  const beforeTrim = lineBefore.trimEnd();
  const afterBlank = lineAfter.trim().length === 0;
  const lastChar = beforeTrim.slice(-1);

  // R5 — near-empty buffer: telemetry shows rawChars≈0 → 100% empty results.
  if (ctx.prefixTotalTrimmedLen < 10) return { skip: true, rule: 'r5' };

  // R6 — pathological line (minified/generated).
  if (lineBefore.length > 500) return { skip: true, rule: 'r6' };

  // R3 — mid-identifier with no member trigger: `foo|bar` completes nothing
  // useful; a `.`/`->`/`::` within the last 3 chars re-enables (member pos).
  const beforeEndsIdent = IDENT_CHAR.test(lineBefore.slice(-1));
  const afterStartsIdent = IDENT_CHAR.test(lineAfter.slice(0, 1));
  const memberNearby = /(?:\.|->|::)[A-Za-z0-9_$]{0,2}$/.test(lineBefore);
  if (beforeEndsIdent && afterStartsIdent && !memberNearby) return { skip: true, rule: 'r3' };

  if (suppression === 'lenient') return NO_SKIP;

  // R1 — cursor at EOL right after a statement ender.
  const enders = suppression === 'strict' ? ENDERS_STRICT : ENDERS_ALL;
  if (afterBlank && lastChar && enders.has(lastChar)) return { skip: true, rule: 'r1' };

  // R2 — inside a line comment whose text is empty or sentence-terminated
  // (mid-sentence comment continuation is a real completion use-case — keep).
  const commentMatch = COMMENT_MARKER.exec(lineBefore);
  if (commentMatch) {
    const commentText = lineBefore.slice(commentMatch.index + commentMatch[0].length).trim();
    if (afterBlank && (commentText === '' || /[.:]$/.test(commentText))) {
      return { skip: true, rule: 'r2' };
    }
  }

  // R4 — an import statement being typed (path completion is the LSP's job).
  if (IMPORT_LINE.test(lineBefore)) return { skip: true, rule: 'r4' };

  return NO_SKIP;
}
