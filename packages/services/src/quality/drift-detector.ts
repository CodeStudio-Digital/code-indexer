/**
 * Drift detector for quality classifiers.
 *
 * Compares a classifier's verdict distribution over a RECENT window
 * against a BASELINE window. When the distributions diverge beyond a
 * configurable threshold, the classifier is "drifting" — either the
 * model changed, the agent's output distribution changed, or both.
 *
 * Uses a simple population-stability-index (PSI) over the {ok, warn,
 * flagged, error} verdict bins. PSI is the standard tool for ML
 * monitoring; values:
 *   <  0.1   stable
 *   0.1-0.25 minor drift
 *   >  0.25  significant drift
 *
 * No heavy stats — same idea as the bucketed histogram already used in
 * the pipeline_telemetry endpoint, applied to classifier verdicts.
 */
import type {
  QualityClassificationStore,
  QualityVerdict,
} from '@mcp/store/quality-classification-store.js';

const VERDICTS: QualityVerdict[] = ['ok', 'warn', 'flagged', 'error'];

export interface DriftReport {
  classifierName: string;
  /** PSI value; higher = more drift. */
  psi: number;
  status: 'stable' | 'minor_drift' | 'significant_drift';
  baseline: Record<QualityVerdict, { count: number; ratio: number }>;
  recent: Record<QualityVerdict, { count: number; ratio: number }>;
  baselineRows: number;
  recentRows: number;
  recommendation: string;
}

export interface DriftDetectorConfig {
  store: QualityClassificationStore;
  /** Window in ms for "recent" samples (default 24h). */
  recentWindowMs?: number;
  /** Window in ms for "baseline" (default 7d, ending at recent start). */
  baselineWindowMs?: number;
  /** Min rows in each window before drift is considered meaningful. */
  minRows?: number;
  /** Now override for tests. */
  now?: () => Date;
}

export class DriftDetector {
  private readonly cfg: Required<DriftDetectorConfig>;
  constructor(cfg: DriftDetectorConfig) {
    this.cfg = {
      store: cfg.store,
      recentWindowMs: cfg.recentWindowMs ?? 24 * 60 * 60 * 1000,
      baselineWindowMs: cfg.baselineWindowMs ?? 7 * 24 * 60 * 60 * 1000,
      minRows: cfg.minRows ?? 30,
      now: cfg.now ?? (() => new Date()),
    };
  }

  /**
   * Compute drift for a single classifier. Returns null if either window
   * has too few samples — drift is meaningless on tiny data.
   *
   * Recent window: now-recentWindowMs → now.
   * Baseline window: now-recentWindowMs-baselineWindowMs → now-recentWindowMs.
   * The two windows are disjoint so PSI is well-defined.
   *
   * Implementation note: `verdictDistribution` only takes a `since` filter,
   * so we get "all rows since X" for both windows, then SUBTRACT recent
   * from baseline to make them disjoint. This avoids a schema change for
   * a between-dates query.
   */
  detect(classifierName: string): DriftReport | null {
    const now = this.cfg.now();
    const recentSinceIso = isoMinus(now, this.cfg.recentWindowMs);
    const baselineSinceIso = isoMinus(now, this.cfg.recentWindowMs + this.cfg.baselineWindowMs);

    // "Baseline + recent" = everything since baselineSinceIso.
    // "Recent" = everything since recentSinceIso.
    // Baseline alone = (baseline + recent) - recent.
    const totalDist = this.cfg.store.verdictDistribution({
      classifierName,
      since: baselineSinceIso,
    });
    const recentDist = this.cfg.store.verdictDistribution({
      classifierName,
      since: recentSinceIso,
    });
    const total = toCountsMap(totalDist, classifierName);
    const recent = toCountsMap(recentDist, classifierName);
    const baseline: Record<QualityVerdict, number> = { ok: 0, warn: 0, flagged: 0, error: 0 };
    for (const v of VERDICTS) baseline[v] = Math.max(0, total[v] - recent[v]);

    const baselineTotal = sumValues(baseline);
    const recentTotal = sumValues(recent);
    if (recentTotal < this.cfg.minRows) return null;
    // For the very first observation period there's no baseline yet.
    // Report a "warming up" status by short-circuiting with PSI=0.
    if (baselineTotal < this.cfg.minRows) {
      const recentRatios = ratios(recent);
      return {
        classifierName,
        psi: 0,
        status: 'stable',
        baseline: pack(baseline, ratios(baseline)),
        recent: pack(recent, recentRatios),
        baselineRows: baselineTotal,
        recentRows: recentTotal,
        recommendation: 'Warming up — not enough baseline samples for meaningful drift detection yet.',
      };
    }

    const baselineRatios = ratios(baseline);
    const recentRatios = ratios(recent);
    const psi = psiBetween(baselineRatios, recentRatios);
    const status = psi >= 0.25 ? 'significant_drift' : psi >= 0.1 ? 'minor_drift' : 'stable';

    return {
      classifierName,
      psi,
      status,
      baseline: pack(baseline, baselineRatios),
      recent: pack(recent, recentRatios),
      baselineRows: baselineTotal,
      recentRows: recentTotal,
      recommendation: recommend(status, recent, recentRatios),
    };
  }

  /** Run drift detection over a list of classifier names. */
  detectAll(classifierNames: string[]): DriftReport[] {
    const reports: DriftReport[] = [];
    for (const c of classifierNames) {
      const r = this.detect(c);
      if (r) reports.push(r);
    }
    return reports;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function isoMinus(now: Date, deltaMs: number): string {
  const t = new Date(now.getTime() - deltaMs);
  return t.toISOString().slice(0, 19).replace('T', ' ');
}

function toCountsMap(
  dist: Array<{ classifier_name: string; verdict: QualityVerdict; count: number }>,
  classifierName: string,
): Record<QualityVerdict, number> {
  const m: Record<QualityVerdict, number> = { ok: 0, warn: 0, flagged: 0, error: 0 };
  for (const d of dist) {
    if (d.classifier_name !== classifierName) continue;
    m[d.verdict] = d.count;
  }
  return m;
}

function sumValues(m: Record<QualityVerdict, number>): number {
  let s = 0;
  for (const v of VERDICTS) s += m[v];
  return s;
}

function ratios(m: Record<QualityVerdict, number>): Record<QualityVerdict, number> {
  const total = sumValues(m) || 1;
  const r: Record<QualityVerdict, number> = { ok: 0, warn: 0, flagged: 0, error: 0 };
  for (const v of VERDICTS) r[v] = m[v] / total;
  return r;
}

/**
 * Population Stability Index:
 *   PSI = Σ (recent_i - baseline_i) × ln(recent_i / baseline_i)
 *
 * Both ratios are clamped to a small epsilon to avoid log(0). Returns 0
 * when the distributions are identical.
 */
function psiBetween(
  baseline: Record<QualityVerdict, number>,
  recent: Record<QualityVerdict, number>,
): number {
  const EPS = 1e-4;
  let psi = 0;
  for (const v of VERDICTS) {
    const b = Math.max(baseline[v], EPS);
    const r = Math.max(recent[v], EPS);
    psi += (r - b) * Math.log(r / b);
  }
  return Math.abs(psi);
}

function pack(
  counts: Record<QualityVerdict, number>,
  ratios: Record<QualityVerdict, number>,
): Record<QualityVerdict, { count: number; ratio: number }> {
  const out: Record<QualityVerdict, { count: number; ratio: number }> = {
    ok: { count: 0, ratio: 0 },
    warn: { count: 0, ratio: 0 },
    flagged: { count: 0, ratio: 0 },
    error: { count: 0, ratio: 0 },
  };
  for (const v of VERDICTS) out[v] = { count: counts[v], ratio: ratios[v] };
  return out;
}

function recommend(
  status: DriftReport['status'],
  counts: Record<QualityVerdict, number>,
  ratios: Record<QualityVerdict, number>,
): string {
  if (status === 'stable') return 'No action needed.';
  if (status === 'minor_drift') return 'Watch — recent verdicts diverge slightly from baseline.';
  // Significant drift: pinpoint which bucket moved.
  const errorRatio = ratios.error;
  if (errorRatio > 0.2) {
    return `High error rate (${(errorRatio * 100).toFixed(0)}%) — check provider availability / API key.`;
  }
  const flaggedRatio = ratios.flagged;
  if (flaggedRatio > 0.3) {
    return `High flagged rate (${(flaggedRatio * 100).toFixed(0)}%) — investigate agent output quality or tighten thresholds.`;
  }
  if (counts.ok / sumValues(counts) > 0.95) {
    return 'Almost everything OK — classifier may be too lenient.';
  }
  return 'Distribution shifted significantly; review classifier prompt + model choice.';
}
