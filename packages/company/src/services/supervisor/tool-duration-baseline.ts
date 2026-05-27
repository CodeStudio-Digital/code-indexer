/**
 * AgentSupervisor — Per-tool duration baseline (Sprint 4 Phase 3.4).
 *
 * Replaces the fixed `AWAITING_TOOL` timeout (5min) with an adaptive
 * threshold per tool name. The baseline samples successful tool
 * completions and exposes percentile-based outlier thresholds. When
 * a tool's current duration exceeds `p90 × factor`, the supervisor
 * flags it as STUCK_TOOL well before the static fallback fires.
 *
 * **Why p90 × factor**: cold runs of new tools shouldn't trip the
 * breaker — factor=2.0 gives genuine outliers (twice the slowest 10%)
 * room to complete normally. Tunable via `MCP_SUPERVISOR_TOOL_OUTLIER_FACTOR`.
 *
 * **Min samples**: don't predict before we have signal. Default 5
 * samples per tool — below that, falls back to the fixed timeout.
 * Tunable via `MCP_SUPERVISOR_TOOL_MIN_SAMPLES`.
 *
 * **Sliding window**: ring buffer per tool (cap 50). Old timing data
 * becomes stale fast (LLM tool implementations evolve). Tunable via
 * `MCP_SUPERVISOR_TOOL_BASELINE_RING_SIZE`.
 *
 * Pure module. No I/O. Singleton lives in process memory.
 */

export interface ToolBaselineConfig {
  /** Min samples before outlier prediction kicks in. Default 5. */
  minSamples: number;
  /** Multiplier on p90 to compute the outlier threshold. Default 2.0. */
  outlierFactor: number;
  /** Ring buffer capacity per tool. Default 50. */
  ringSize: number;
}

export interface ToolBaselineStats {
  toolName: string;
  samples: number;
  p50: number;
  p90: number;
  p99: number;
  /** Outlier threshold (p90 × factor). Null when below minSamples. */
  outlierThresholdMs: number | null;
}

export const DEFAULT_BASELINE_CONFIG: ToolBaselineConfig = Object.freeze({
  minSamples: 5,
  outlierFactor: 2.0,
  ringSize: 50,
});

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function baselineConfigFromEnv(): ToolBaselineConfig {
  return {
    minSamples: envInt(
      'MCP_SUPERVISOR_TOOL_MIN_SAMPLES',
      DEFAULT_BASELINE_CONFIG.minSamples,
    ),
    outlierFactor: envFloat(
      'MCP_SUPERVISOR_TOOL_OUTLIER_FACTOR',
      DEFAULT_BASELINE_CONFIG.outlierFactor,
    ),
    ringSize: envInt(
      'MCP_SUPERVISOR_TOOL_BASELINE_RING_SIZE',
      DEFAULT_BASELINE_CONFIG.ringSize,
    ),
  };
}

/**
 * Computes the percentile from a sorted array. Linear interpolation
 * between buckets for fractional indices. Returns NaN on empty input.
 */
function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export class ToolDurationBaseline {
  private readonly cfg: ToolBaselineConfig;
  private readonly samples = new Map<string, number[]>();

  constructor(cfg: Partial<ToolBaselineConfig> = {}) {
    this.cfg = { ...DEFAULT_BASELINE_CONFIG, ...cfg };
  }

  getConfig(): ToolBaselineConfig {
    return { ...this.cfg };
  }

  /**
   * Record a successful tool completion. The duration becomes a new
   * data point in this tool's ring buffer. Oldest samples are evicted
   * when the ring reaches capacity.
   */
  recordSuccess(toolName: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const ring = this.samples.get(toolName) ?? [];
    ring.push(durationMs);
    if (ring.length > this.cfg.ringSize) ring.shift();
    this.samples.set(toolName, ring);
  }

  /**
   * Compute outlier threshold for a tool — p90 × outlierFactor.
   * Returns null when we don't have enough samples yet (below
   * `minSamples`). Caller falls back to the fixed default timeout
   * in that case.
   */
  outlierThresholdMs(toolName: string): number | null {
    const ring = this.samples.get(toolName);
    if (!ring || ring.length < this.cfg.minSamples) return null;
    const sorted = ring.slice().sort((a, b) => a - b);
    const p90 = percentile(sorted, 0.9);
    if (!Number.isFinite(p90) || p90 <= 0) return null;
    return Math.round(p90 * this.cfg.outlierFactor);
  }

  /** Diagnostic snapshot per tool. Empty array for never-seen tools. */
  getStats(toolName: string): ToolBaselineStats {
    const ring = this.samples.get(toolName) ?? [];
    if (ring.length === 0) {
      return { toolName, samples: 0, p50: 0, p90: 0, p99: 0, outlierThresholdMs: null };
    }
    const sorted = ring.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p90 = percentile(sorted, 0.9);
    const p99 = percentile(sorted, 0.99);
    return {
      toolName,
      samples: ring.length,
      p50: Math.round(p50),
      p90: Math.round(p90),
      p99: Math.round(p99),
      outlierThresholdMs:
        ring.length >= this.cfg.minSamples ? Math.round(p90 * this.cfg.outlierFactor) : null,
    };
  }

  /** All tools observed so far. Useful for admin status panel. */
  allStats(): ToolBaselineStats[] {
    return Array.from(this.samples.keys()).map((name) => this.getStats(name));
  }

  /** Test helper — reset state. */
  clearForTests(): void {
    this.samples.clear();
  }
}

// ─── Process-wide singleton ───────────────────────────────────────

let globalBaseline: ToolDurationBaseline | null = null;

/**
 * Lazy singleton. Initialized on first access using env config so
 * tests can override via `setGlobalToolBaselineForTests`.
 */
export function getGlobalToolBaseline(): ToolDurationBaseline {
  if (!globalBaseline) {
    globalBaseline = new ToolDurationBaseline(baselineConfigFromEnv());
  }
  return globalBaseline;
}

/** Test helper — replace the singleton or clear it (pass null). */
export function setGlobalToolBaselineForTests(
  next: ToolDurationBaseline | null,
): void {
  globalBaseline = next;
}
