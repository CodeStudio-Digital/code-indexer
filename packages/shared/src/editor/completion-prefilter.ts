/**
 * Request suppression for AI completion — Copilot's contextual filter:
 * deterministic rules (R1–R6) over the cursor line that skip positions where
 * a completion is near-certain to be useless, plus a LEARNED gate (R7 — the
 * logistic flavor of JetBrains fullLine's "trigger model") fitted offline on
 * our own shown→accept/reject telemetry. Each skipped request saves a
 * debounce wait + provider call. Pure string work: lives in @mcp/shared so
 * the dashboard (not tsc-checked) gets a type-checked, unit-tested
 * implementation and the server (api-handlers) records the same features.
 */
import { COMPLETION_GATE_WEIGHTS, type CompletionGateWeights } from './completion-gate-weights.js';

/** Active weights — swappable in tests; production always ships the generated file. */
let activeWeights: CompletionGateWeights = COMPLETION_GATE_WEIGHTS;

export function __setGateWeightsForTests(w: CompletionGateWeights | null): void {
  activeWeights = w ?? COMPLETION_GATE_WEIGHTS;
}

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

  // R7 — learned gate (trigger-model): logistic score over cheap positional
  // features, trained offline on our shown→accept/reject telemetry. Inert
  // until a training run ships weights (trainedAt null → not even extracted).
  // Lenient mode exited above — the escape hatch stays deterministic.
  if (activeWeights.trainedAt !== null) {
    const score = scoreAcceptLikelihood(extractGateFeatures(ctx));
    if (score < activeWeights.thresholds[suppression]) return { skip: true, rule: 'r7' };
  }

  return NO_SKIP;
}

// ─── Learned gate (R7) — feature extraction + scoring ────────────────────

/** Bump together with the layout below; must match the weights file version. */
export const GATE_FEATURE_VERSION = 1;

const OPEN_BRACKETS = new Set(['(', '[', '{']);
const OPERATOR_CHARS = new Set(['=', '+', '-', '*', '/', '%', '<', '>', '&', '|', '^', '!', '?', ':', ',']);
const CURLY_LANGS = new Set([
  'typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'java', 'csharp',
  'php', 'go', 'rust', 'c', 'cpp', 'kotlin', 'swift', 'scala', 'dart',
]);
const INDENT_LANGS = new Set(['python', 'ruby', 'yaml', 'coffeescript']);

/**
 * Fixed 13-slot vector (GATE_FEATURE_VERSION contract, consumed by the
 * trainer and by scoreAcceptLikelihood — order is load-bearing):
 *  0 last char is identifier · 1 last char opens a bracket · 2 member trigger
 *  (`.`/`->`/`::`) nearby · 3 last char is an operator · 4 line-after blank ·
 *  5 cursor on blank line-before · 6 indent depth (0..1) · 7 line length
 *  (0..1) · 8 prefix size (0..1) · 9 inside string (odd quotes) · 10 inside
 *  line comment · 11 curly-brace language · 12 indentation language.
 */
export function extractGateFeatures(
  ctx: Pick<PrefilterCtx, 'lineBefore' | 'lineAfter' | 'languageId' | 'prefixTotalTrimmedLen'>,
): number[] {
  const { lineBefore, lineAfter } = ctx;
  const beforeTrim = lineBefore.trimEnd();
  const lastChar = beforeTrim.slice(-1);
  const indent = /^[ \t]*/.exec(lineBefore)?.[0] ?? '';
  let indentUnits = 0;
  for (const ch of indent) indentUnits += ch === '\t' ? 1 : 0.25;
  const quotes = (lineBefore.match(/["'`]/g) ?? []).length;
  return [
    lastChar !== '' && IDENT_CHAR.test(lastChar) ? 1 : 0,
    OPEN_BRACKETS.has(lastChar) ? 1 : 0,
    /(?:\.|->|::)[A-Za-z0-9_$]{0,2}$/.test(lineBefore) ? 1 : 0,
    OPERATOR_CHARS.has(lastChar) ? 1 : 0,
    lineAfter.trim().length === 0 ? 1 : 0,
    beforeTrim.length === 0 ? 1 : 0,
    Math.min(indentUnits, 8) / 8,
    Math.min(lineBefore.length, 160) / 160,
    Math.min(ctx.prefixTotalTrimmedLen, 4000) / 4000,
    quotes % 2 === 1 ? 1 : 0,
    COMMENT_MARKER.test(lineBefore) ? 1 : 0,
    CURLY_LANGS.has(ctx.languageId) ? 1 : 0,
    INDENT_LANGS.has(ctx.languageId) ? 1 : 0,
  ];
}

/** sigmoid(bias + w·f) — p(the user would accept a completion here). */
export function scoreAcceptLikelihood(features: readonly number[]): number {
  const w = activeWeights;
  let z = w.bias;
  const n = Math.min(features.length, w.weights.length);
  for (let i = 0; i < n; i++) z += features[i]! * w.weights[i]!;
  return 1 / (1 + Math.exp(-z));
}
