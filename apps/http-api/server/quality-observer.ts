/**
 * Quality v2 — Aggregated board alert observer (Wires #4 + B1/B2 of v2 plan).
 *
 * Why v2:
 *   v1 (`makeOffTopicAlertObserver`) posted a fresh board entry every time
 *   `off_topic=flagged` fired above the confidence floor. In a session with
 *   recurrent drift the master saw N alerts within minutes — pure spam.
 *
 *   v2 replaces that with an **in-memory aggregation buffer**:
 *     - Buckets keyed by `(agentRunId, classifierName)`.
 *     - Each flagged verdict UPDATES the bucket (count, exemplars).
 *     - We FLUSH (post to board) when the bucket hits a count threshold
 *       OR when a flush-interval elapses since the bucket started.
 *     - After flushing, the bucket enters a long cooldown — more flagged
 *       verdicts during cooldown ONLY update the counter; they do NOT
 *       trigger new alerts.
 *     - Auto-trim drops idle buckets (no update in > 1h).
 *
 *   v2 also widens coverage: `policy=flagged` and `tool_misuse=flagged`
 *   now generate alerts too (each in its own bucket). This was unsafe in
 *   v1 because it would have multiplied the spam; with aggregation it's
 *   net-positive.
 *
 * Tunables (env):
 *   MCP_QUALITY_ALERT_FLUSH_THRESHOLD     — default 5
 *   MCP_QUALITY_ALERT_FLUSH_INTERVAL_MS   — default 10 * 60_000 (10min)
 *   MCP_QUALITY_ALERT_COOLDOWN_MS         — default 30 * 60_000 (30min)
 *   MCP_QUALITY_ALERT_IDLE_TRIM_MS        — default 60 * 60_000 (1h)
 *   MCP_QUALITY_ALERT_MIN_CONFIDENCE      — default 0.7 (was 0.8 in v1; lower OK now because aggregation prevents spam)
 *
 * Never throws — the global observer dispatcher already swallows errors,
 * but we keep defense-in-depth here so a buggy orchestrator can't crash
 * the classifier path.
 */
import type {
  AgentOutputForClassification,
  ClassificationVerdict,
  QualityResult,
  QualityResultObserver,
} from '@mcp/services/quality/index.js';
import { orchestratorRegistry } from '../sse/OrchestratorRegistry.js';

/**
 * Classifiers we DO post alerts for. Each gets an independent bucket per
 * agent_run. Keep this list short — every classifier added widens the
 * potential alert volume even with aggregation.
 */
const ALERTABLE_CLASSIFIERS = new Set(['off_topic', 'policy', 'tool_misuse']);

const MIN_CONFIDENCE = clampFraction(
  Number(process.env.MCP_QUALITY_ALERT_MIN_CONFIDENCE ?? 0.7),
);
const FLUSH_THRESHOLD = Math.max(
  1,
  Number(process.env.MCP_QUALITY_ALERT_FLUSH_THRESHOLD ?? 5),
);
const FLUSH_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.MCP_QUALITY_ALERT_FLUSH_INTERVAL_MS ?? 10 * 60_000),
);
const COOLDOWN_MS = Math.max(
  FLUSH_INTERVAL_MS,
  Number(process.env.MCP_QUALITY_ALERT_COOLDOWN_MS ?? 30 * 60_000),
);
const IDLE_TRIM_MS = Math.max(
  10 * 60_000,
  Number(process.env.MCP_QUALITY_ALERT_IDLE_TRIM_MS ?? 60 * 60_000),
);

interface AlertBucket {
  /** `agentRunId::classifierName` for lookup. */
  key: string;
  /** Company session whose orchestrator should receive the alert. */
  companySessionId: number;
  /** Agent run id for the message body. May be null in unattributed sessions. */
  agentRunId: number | null;
  classifierName: string;
  /** First flagged verdict that entered this bucket (post-cooldown if applicable). */
  firstSeenMs: number;
  /** Most recent flagged verdict. */
  lastSeenMs: number;
  /** Count of flagged verdicts since `firstSeenMs`. */
  count: number;
  /**
   * Up to 3 most recent verdicts kept for the flush message body
   * ("Exemplars: ..."). Rotated FIFO; older drop off as new arrive.
   */
  exemplars: Array<{ reason: string | null; confidence: number | null; messageId: string | null }>;
  /** First turn id in the window (parsed from `messageId = turn-N`). */
  firstTurnId: number | null;
  /** Most recent turn id in the window. */
  lastTurnId: number | null;
  /**
   * When set, the bucket is in COOLDOWN — flagged verdicts still update
   * count but won't trigger a flush until this time has passed.
   */
  cooldownUntilMs: number | null;
}

type AlertEmitter = (sessionId: number, body: string) => void;

interface BufferState {
  buckets: Map<string, AlertBucket>;
  emit: AlertEmitter;
  now: () => number;
  trimTimer: NodeJS.Timeout | null;
}

/**
 * Module-level singleton state. Reset by tests via `resetQualityAlertBuffer`.
 * Singleton (not per-observer-instance) so multiple subscribers — should
 * we ever add any — see a consistent buffer.
 */
let state: BufferState | null = null;

function ensureState(emit?: AlertEmitter): BufferState {
  if (state) {
    if (emit) state.emit = emit; // allow re-installation with a fresh emitter (test re-use)
    return state;
  }
  state = {
    buckets: new Map(),
    emit: emit ?? defaultEmitToOrchestrator,
    now: () => Date.now(),
    trimTimer: null,
  };
  // Periodic trim — drops buckets idle for IDLE_TRIM_MS. Runs every minute.
  // The interval is cleared on test reset; in production it stays alive
  // for the lifetime of the process.
  state.trimTimer = setInterval(() => {
    if (!state) return;
    const cutoff = state.now() - IDLE_TRIM_MS;
    for (const [k, b] of state.buckets) {
      if (b.lastSeenMs < cutoff) state.buckets.delete(k);
    }
  }, 60_000);
  state.trimTimer.unref?.();
  return state;
}

function defaultEmitToOrchestrator(sessionId: number, body: string): void {
  const orch = orchestratorRegistry.get(sessionId);
  if (!orch) return; // session evicted — silently skip
  try {
    orch.postToBoard('quality-gate', null, 'message', body, ['master']);
  } catch {
    /* never throw from observer */
  }
}

/**
 * Build the observer registered via `setGlobalQualityResultObserver` at boot.
 * Replaces v1's `makeOffTopicAlertObserver` directly.
 */
export function makeQualityAlertObserver(opts?: {
  emit?: AlertEmitter;
  now?: () => number;
}): QualityResultObserver {
  const buf = ensureState(opts?.emit);
  if (opts?.now) buf.now = opts.now;
  return (result: QualityResult, output: AgentOutputForClassification) => {
    try {
      if (output.companySessionId == null) return; // chat-individual sessions have no master
      const companySessionId = output.companySessionId;
      const agentRunId = output.agentRunId ?? null;
      for (const v of result.verdicts) {
        if (!ALERTABLE_CLASSIFIERS.has(v.classifierName)) continue;
        if (v.verdict !== 'flagged') continue;
        if ((v.confidence ?? 0) < MIN_CONFIDENCE) continue;
        handleFlaggedVerdict(buf, companySessionId, agentRunId, v, output.messageId ?? null);
      }
    } catch {
      // Observer NEVER throws.
    }
  };
}

function handleFlaggedVerdict(
  buf: BufferState,
  companySessionId: number,
  agentRunId: number | null,
  verdict: ClassificationVerdict,
  messageId: string | null,
): void {
  const now = buf.now();
  // Key includes companySessionId in case the same agent_run id appears in
  // two sessions (extremely rare but cheap guard).
  const runKey = agentRunId != null ? String(agentRunId) : `noagent-${companySessionId}`;
  const key = `${runKey}::${verdict.classifierName}`;
  const turnId = parseTurnId(messageId);

  let b = buf.buckets.get(key);
  if (!b) {
    b = {
      key,
      companySessionId,
      agentRunId,
      classifierName: verdict.classifierName,
      firstSeenMs: now,
      lastSeenMs: now,
      count: 0,
      exemplars: [],
      firstTurnId: turnId,
      lastTurnId: turnId,
      cooldownUntilMs: null,
    };
    buf.buckets.set(key, b);
  }
  b.lastSeenMs = now;
  b.count += 1;
  b.lastTurnId = turnId ?? b.lastTurnId;
  // Keep last 3 exemplars (FIFO).
  b.exemplars.push({
    reason: verdict.reason ?? null,
    confidence: verdict.confidence ?? null,
    messageId,
  });
  if (b.exemplars.length > 3) b.exemplars.shift();

  // If we're inside the cooldown window, only update; don't flush.
  if (b.cooldownUntilMs != null && now < b.cooldownUntilMs) return;

  const shouldFlushByCount = b.count >= FLUSH_THRESHOLD;
  const shouldFlushByTime = now - b.firstSeenMs >= FLUSH_INTERVAL_MS;
  if (shouldFlushByCount || shouldFlushByTime) {
    flushBucket(buf, b, now);
  }
}

function flushBucket(buf: BufferState, b: AlertBucket, now: number): void {
  const body = formatBucketAlert(b);
  try { buf.emit(b.companySessionId, body); } catch { /* swallow */ }
  // Enter cooldown — keep the bucket alive so subsequent flagged verdicts
  // bump the counter but don't fire fresh alerts.
  b.cooldownUntilMs = now + COOLDOWN_MS;
  // Reset accumulators for the NEXT window so when cooldown elapses the
  // bucket starts fresh.
  b.firstSeenMs = now;
  b.firstTurnId = b.lastTurnId;
  b.count = 0;
  b.exemplars = [];
}

function formatBucketAlert(b: AlertBucket): string {
  const runText = b.agentRunId != null ? `run #${b.agentRunId}` : 'an unattributed run';
  const turnRange = b.firstTurnId != null && b.lastTurnId != null && b.firstTurnId !== b.lastTurnId
    ? `between turn ${b.firstTurnId}-${b.lastTurnId}`
    : (b.lastTurnId != null ? `at turn ${b.lastTurnId}` : '');
  const exemplarsText = b.exemplars
    .map((e, i) => {
      const conf = e.confidence != null ? ` (${Math.round(e.confidence * 100)}%)` : '';
      const reason = e.reason ? truncateOneLine(e.reason, 200) : '(no reason)';
      return `  ${i + 1}.${conf} "${reason}"`;
    })
    .join('\n');
  return [
    `⚠️ **${b.classifierName}** drift on ${runText}` + (turnRange ? ` ${turnRange}` : ''),
    '',
    `**${b.count} flag(s)** observed in the last ${Math.round((b.lastSeenMs - b.firstSeenMs) / 60_000)} min.`,
    '',
    `Recent exemplars:`,
    exemplarsText,
    '',
    `Next alert for this run/classifier suppressed for ${Math.round(/* cooldown */ COOLDOWN_MS / 60_000)} min unless drift continues.`,
  ].join('\n');
}

function parseTurnId(messageId: string | null): number | null {
  if (!messageId) return null;
  const m = messageId.match(/^turn-(\d+)$/);
  return m ? Number(m[1]) : null;
}

function truncateOneLine(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
}

function clampFraction(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── Test helpers (NOT exported from the production index) ───────────────

/**
 * Reset the in-memory buffer. Tests use this between cases to start clean.
 * No-op in production.
 */
export function resetQualityAlertBuffer(): void {
  if (state?.trimTimer) clearInterval(state.trimTimer);
  state = null;
}

/** Test-only: snapshot the current bucket state. */
export function inspectQualityAlertBuckets(): Array<{
  key: string;
  count: number;
  cooldownUntilMs: number | null;
  exemplars: number;
}> {
  if (!state) return [];
  return Array.from(state.buckets.values()).map((b) => ({
    key: b.key,
    count: b.count,
    cooldownUntilMs: b.cooldownUntilMs,
    exemplars: b.exemplars.length,
  }));
}
