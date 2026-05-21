/**
 * Quality feedback builder — turns raw `quality_classifications` rows
 * into the two pieces of structured text that get appended to the next
 * system prompt:
 *
 *   1. `buildQualityNudge(verdicts)` — Wire #1, Nível 1.
 *      Soft, low-risk corrective hints. One line per misbehaving
 *      classifier (the most recent `warn` or `flagged` row for each
 *      classifier name with confidence >= threshold). The agent reads
 *      this as part of its system context — no enforcement.
 *
 *   2. `detectToolMisuseStreak(verdicts)` — Wire #2, Nível 3a.
 *      Streak detector for the `tool_misuse` classifier. When the
 *      last 3 verdicts are ALL `flagged` (within the same session, in
 *      time order, ignoring `ok`/`error` interleavings), the runner
 *      switches the next turn to a forced planning turn — model is
 *      told to stop, name the loop, propose a different approach.
 *
 * Both functions are PURE. They take rows in and emit text/booleans
 * out. No DB access, no side effects. That keeps them dead-simple to
 * unit test and reusable across surfaces (chat individual, company
 * subordinates).
 */
import type {
  QualityClassificationRow,
  QualityVerdict,
} from '@mcp/store/quality-classification-store.js';
import type { ClassificationVerdict } from './types.js';

export interface QualityFeedbackBlock {
  /** Full text to append. Empty string when there's nothing to say. */
  text: string;
  /** Verdicts that contributed to the text. Used for telemetry/tests. */
  contributingClassifiers: ReadonlyArray<string>;
}

/**
 * Confidence threshold below which a verdict is too noisy to act on.
 * Picked at 0.6 — same band the dashboard uses for the "high-confidence"
 * coloring. Tunable per-call.
 */
const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Corrective hint templates indexed by classifier name. The model receives
 * "your last turn was flagged as <X>; <hint>". Hints are intentionally
 * generic — the classifier's own `reason` field is appended after them so
 * the model gets both the rule and the specific evidence.
 */
const HINT_TEMPLATES: Record<string, { warn: string; flagged: string }> = {
  off_topic: {
    warn: 'You drifted slightly. Refocus on the user\'s original ask before continuing.',
    flagged: 'Your last reply did not address the user\'s task. Re-read the latest user message and answer that specifically — do not pivot to a related topic.',
  },
  completeness: {
    warn: 'Important steps remain. Make this turn deliver concrete work — run commands, write files, finish what you outlined.',
    flagged: 'You stated intent but did not act. This turn, EXECUTE: call the tools you described, write the code, run the command. Do not narrate — do.',
  },
  code_quality: {
    warn: 'A code smell slipped in (TODO, console.log, magic number, or similar). Clean it up this turn before adding more code.',
    flagged: 'Multiple code smells in your last output. STOP adding code; this turn, fix the smells (TODOs without implementation, console.log left behind, swallowed exceptions, hard-coded values).',
  },
  policy: {
    warn: 'Borderline operation detected. Double-check destructive commands are scoped correctly and no secrets are about to be hard-coded.',
    flagged: 'A policy concern was raised about your last turn. Do NOT repeat the action. Re-read your previous output, identify the destructive command or hard-coded secret, and propose a safe alternative.',
  },
  tool_misuse: {
    warn: 'A suspicious tool-call pattern appeared (repeated identical call, or wrong tool for the task). This turn, vary your approach.',
    flagged: 'You are misusing tools — same call repeated, or a tool obviously wrong for the task. STOP and reconsider. Read what you already have before calling another tool.',
  },
};

/**
 * Build a soft, single-block nudge to append to the next system prompt.
 *
 * Behavior:
 *   - Group rows by `classifier_name`, take the most recent per classifier.
 *   - Drop rows where verdict is `ok` or `error`.
 *   - Drop rows with confidence below `minConfidence`.
 *   - Drop rows whose classifier we don't have a template for (defensive).
 *   - Cap output at 5 hints (one per classifier).
 *   - Return empty block when nothing qualifies.
 *
 * The exact wording was tuned in `classifiers.test.ts` against the patterns
 * the user observed in production (intent-without-execution dominated).
 */
export function buildQualityNudge(
  verdicts: ReadonlyArray<QualityClassificationRow>,
  opts: { minConfidence?: number } = {},
): QualityFeedbackBlock {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  // Pick most recent (already sorted DESC by caller) per classifier name.
  const seen = new Set<string>();
  const picked: QualityClassificationRow[] = [];
  for (const row of verdicts) {
    if (seen.has(row.classifier_name)) continue;
    if (!isActionableVerdict(row.verdict)) continue;
    if ((row.confidence ?? 0) < minConfidence) continue;
    if (!HINT_TEMPLATES[row.classifier_name]) continue;
    seen.add(row.classifier_name);
    picked.push(row);
    if (picked.length >= 5) break;
  }

  if (picked.length === 0) {
    return { text: '', contributingClassifiers: [] };
  }

  const lines: string[] = [
    '',
    '<!-- quality-feedback (auto-generated; do not echo back to the user) -->',
    '## Heads-up from quality classifiers',
    '',
    'Your previous turn(s) were judged on these dimensions and flagged. Course-correct THIS turn:',
    '',
  ];
  for (const row of picked) {
    const tmpl = HINT_TEMPLATES[row.classifier_name];
    const hint = row.verdict === 'flagged' ? tmpl.flagged : tmpl.warn;
    const evidence = row.reason ? ` Evidence from classifier: "${truncateOneLine(row.reason, 220)}".` : '';
    const conf = row.confidence != null ? ` (${Math.round(row.confidence * 100)}%)` : '';
    lines.push(`- **${row.classifier_name}** [${row.verdict}${conf}] — ${hint}${evidence}`);
  }
  lines.push('');
  lines.push('Treat this as a high-priority correction. Do not acknowledge or quote this block in your reply to the user — just act on it.');
  lines.push('');

  return {
    text: lines.join('\n'),
    contributingClassifiers: picked.map((r) => r.classifier_name),
  };
}

/**
 * Detect a `tool_misuse` streak — last 3 verdicts ALL flagged.
 *
 * Returns an object instead of a bare boolean so the caller can pull the
 * latest reason for the intervention header. When `triggered=false` the
 * other fields are empty.
 *
 * Implementation notes:
 *   - Caller passes rows newest-first (the store's default order).
 *   - We scan rows where `classifier_name = 'tool_misuse'` only — any
 *     pre-filter on the caller side is welcome but not required (we
 *     defensively re-filter here).
 *   - Rows with verdict `error` (provider failed / unparseable) DO NOT
 *     count as flagged — they're noise. They also don't break the streak
 *     (we just skip them).
 *   - We require AT LEAST 3 non-error rows in the recent window. If fewer
 *     exist, no streak.
 */
export function detectToolMisuseStreak(
  verdicts: ReadonlyArray<QualityClassificationRow>,
  opts: { minConfidence?: number; streakLength?: number } = {},
): { triggered: boolean; latestReason: string | null; latestConfidence: number | null } {
  const minConfidence = opts.minConfidence ?? 0.5;
  const streakLength = Math.max(2, opts.streakLength ?? 3);

  const considered: QualityClassificationRow[] = [];
  for (const row of verdicts) {
    if (row.classifier_name !== 'tool_misuse') continue;
    if (row.verdict === 'error') continue; // skip noise — don't break the streak either
    considered.push(row);
    if (considered.length >= streakLength) break;
  }
  if (considered.length < streakLength) {
    return { triggered: false, latestReason: null, latestConfidence: null };
  }
  const allFlagged = considered.every(
    (r) => r.verdict === 'flagged' && (r.confidence ?? 0) >= minConfidence,
  );
  if (!allFlagged) {
    return { triggered: false, latestReason: null, latestConfidence: null };
  }
  return {
    triggered: true,
    latestReason: considered[0].reason ?? null,
    latestConfidence: considered[0].confidence ?? null,
  };
}

function isActionableVerdict(v: QualityVerdict): boolean {
  return v === 'warn' || v === 'flagged';
}

function truncateOneLine(text: string, max: number): string {
  // Collapse newlines so the nudge stays on one bulleted line.
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
}

// ─── v2 helpers — adaptive sampling + outcome scoring ────────────────────

/**
 * Severity weights used by {@link computeOutcome}. Higher = worse. 'error'
 * is intentionally **ignored** (treated as missing data, not a regression)
 * because provider hiccups shouldn't dominate the effectiveness metric.
 */
const VERDICT_SEVERITY: Record<QualityVerdict, number> = {
  ok: 0,
  warn: 1,
  flagged: 2,
  error: -1,
};

export interface ShouldClassifyTurnOpts {
  /** Current turn index (1-based). */
  turn: number;
  /** Session id — combined with `turn` to deterministically sample. */
  sessionId: number;
  /** True if the assistant emitted prose; false when the turn was pure tool_use. */
  hasNarrativeText: boolean;
  /**
   * Worst verdict from the LAST classified turn (in the same session).
   * `null` means we have no recent verdict — usually because we just
   * skipped a turn or the session just started.
   */
  lastWorstVerdict: QualityVerdict | null;
  /**
   * Number of consecutive turns to ALWAYS classify at session start
   * (warmup). Default 5 — captures the early-drift signal that's most
   * valuable in short sessions.
   */
  warmupTurns?: number;
  /**
   * Sampling rate applied OUTSIDE warmup AND when last verdict is `ok`.
   * Default 1/3 — empirically gives ~60% cost reduction on long sessions
   * without losing drift detection (which is gated by the predicate path
   * below, not by sampling).
   */
  sampleRate?: number;
}

/**
 * Decide whether to invoke the 5-classifier pipeline for THIS turn.
 *
 * The policy order — first match wins:
 *
 *   1. **No narrative** — turn was pure tool_use → **skip**. There's
 *      nothing for the classifiers to score (they all operate on assistant
 *      prose, not on tool calls).
 *   2. **Warmup** — turn ≤ `warmupTurns` (default 5) → **classify**.
 *      Captures the early-drift pattern (off-topic from the start, etc).
 *   3. **Pressure mode** — last turn was warn/flagged → **classify**.
 *      Keeps the loop tight while there's a known issue; ensures the
 *      nudge keeps firing until the model recovers.
 *   4. **Sampled** — deterministic FNV-1a hash of `session_id × turn` <
 *      `sampleRate` (default 1/3) → **classify**. Deterministic so the
 *      same session always samples the same turns (reproducibility +
 *      no observer-effect bias in counterfactual analysis).
 *   5. **Otherwise** — **skip**.
 *
 * Pure function; no DB access, no side effects.
 */
export function shouldClassifyTurn(opts: ShouldClassifyTurnOpts): boolean {
  if (!opts.hasNarrativeText) return false;
  const warmupTurns = opts.warmupTurns ?? 5;
  if (opts.turn <= warmupTurns) return true;
  if (opts.lastWorstVerdict === 'warn' || opts.lastWorstVerdict === 'flagged') return true;
  const sampleRate = opts.sampleRate ?? 1 / 3;
  return fnv1aSample(opts.sessionId, opts.turn) < sampleRate;
}

/**
 * Deterministic FNV-1a hash → [0, 1). Same input always returns the same
 * fraction, so a given (session, turn) tuple is either always sampled or
 * never sampled — which means we can re-run analysis on the same DB
 * without producing different sampling decisions.
 *
 * Borrowed from `packages/services/src/shadow-traffic/shadow-traffic-runner.ts`.
 */
function fnv1aSample(sessionId: number, turn: number): number {
  const text = `${sessionId}::${turn}`;
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 0x100000000;
}

export type InterventionOutcome = 'improved' | 'unchanged' | 'worsened';

/**
 * Compute whether an intervention (nudge / planning / policy block) made
 * the agent's behavior better, worse, or unchanged on the next turn.
 *
 * Algorithm:
 *   - Pair verdicts by `classifierName` (before, after).
 *   - Map each verdict to a severity score: ok=0, warn=1, flagged=2.
 *   - `error` is ignored (treated as missing — provider hiccups
 *     shouldn't dominate the effectiveness signal).
 *   - Sum the per-classifier deltas (after - before).
 *
 * Result:
 *   - sum < 0 → 'improved' (at least one classifier dropped severity)
 *   - sum > 0 → 'worsened' (severity rose)
 *   - sum == 0 → 'unchanged'
 *
 * Pure; no DB.
 */
export function computeOutcome(
  before: ReadonlyArray<Pick<ClassificationVerdict, 'classifierName' | 'verdict'>>,
  after: ReadonlyArray<Pick<ClassificationVerdict, 'classifierName' | 'verdict'>>,
): InterventionOutcome {
  const beforeByName = new Map<string, QualityVerdict>();
  for (const v of before) beforeByName.set(v.classifierName, v.verdict);
  let delta = 0;
  for (const v of after) {
    const prev = beforeByName.get(v.classifierName);
    if (prev === undefined) continue;
    const prevSev = VERDICT_SEVERITY[prev];
    const nextSev = VERDICT_SEVERITY[v.verdict];
    if (prevSev < 0 || nextSev < 0) continue; // skip `error`
    delta += nextSev - prevSev;
  }
  if (delta < 0) return 'improved';
  if (delta > 0) return 'worsened';
  return 'unchanged';
}

/**
 * Extract the worst verdict from a row set. Used by the sampling gate
 * to feed `lastWorstVerdict` into `shouldClassifyTurn`. Most callers want
 * the verdict from the SINGLE most-recent turn, so they should pre-filter
 * to that turn's rows.
 *
 * `error` is treated as `ok` because the call effectively didn't happen.
 */
export function worstVerdictOf(rows: ReadonlyArray<QualityClassificationRow>): QualityVerdict | null {
  if (rows.length === 0) return null;
  let worst: QualityVerdict = 'ok';
  for (const r of rows) {
    if (r.verdict === 'flagged') return 'flagged';
    if (r.verdict === 'warn' && worst === 'ok') worst = 'warn';
  }
  return worst;
}
