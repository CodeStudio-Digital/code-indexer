import type { Database as DB } from 'better-sqlite3';

export interface CompletedSubagentSample {
  profile: string;
  turns: number;
  logicalOperations: number;
  elapsedMs: number;
  startedAtMs: number;
  completedAtMs: number;
}

export interface SubagentBudgetRecommendation {
  profile: string;
  completedRuns: number;
  observationDays: number;
  p99: {
    turns: number;
    logicalOperations: number;
    durationMs: number;
  };
  /** A 25% safety margin over the observed p99, never a live enforcement. */
  recommended: {
    maxTurns: number;
    maxLogicalOperations: number | null;
    timeoutMs: number;
  };
}

const MIN_COMPLETED_RUNS = 50;
const MIN_OBSERVATION_DAYS = 14;
const SAFETY_MARGIN = 1.25;
const DAY_MS = 24 * 60 * 60 * 1000;

function p99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
}

/** Pure analysis only: this function never changes a subagent budget. */
export function recommendSubagentBudgets(
  samples: ReadonlyArray<CompletedSubagentSample>,
): SubagentBudgetRecommendation[] {
  const byProfile = new Map<string, CompletedSubagentSample[]>();
  for (const sample of samples) {
    if (!sample.profile || !Number.isFinite(sample.startedAtMs) || !Number.isFinite(sample.completedAtMs)) continue;
    const group = byProfile.get(sample.profile) ?? [];
    group.push(sample);
    byProfile.set(sample.profile, group);
  }

  const recommendations: SubagentBudgetRecommendation[] = [];
  for (const [profile, group] of byProfile) {
    if (group.length < MIN_COMPLETED_RUNS) continue;
    const first = Math.min(...group.map((s) => s.startedAtMs));
    const last = Math.max(...group.map((s) => s.completedAtMs));
    const observationDays = (last - first) / DAY_MS;
    if (observationDays < MIN_OBSERVATION_DAYS) continue;

    const turns = p99(group.map((s) => Math.max(0, s.turns)));
    const logicalOperations = p99(group.map((s) => Math.max(0, s.logicalOperations)));
    const durationMs = p99(group.map((s) => Math.max(0, s.elapsedMs)));
    recommendations.push({
      profile,
      completedRuns: group.length,
      observationDays,
      p99: { turns, logicalOperations, durationMs },
      recommended: {
        maxTurns: Math.ceil(turns * SAFETY_MARGIN),
        maxLogicalOperations: profile === 'explore'
          ? null
          : Math.ceil(logicalOperations * SAFETY_MARGIN),
        timeoutMs: Math.ceil(durationMs * SAFETY_MARGIN),
      },
    });
  }
  return recommendations.sort((a, b) => a.profile.localeCompare(b.profile));
}

export function getSubagentBudgetRecommendations(db: DB): SubagentBudgetRecommendation[] {
  const rows = db.prepare(`
    SELECT profile, turns, logical_operations, elapsed_ms,
           started_at, completed_at
      FROM coder_subagent_runs
     WHERE reason = 'completed'
       AND completed_at IS NOT NULL
       AND has_summary = 1
  `).all() as Array<{
    profile: string;
    turns: number;
    logical_operations: number;
    elapsed_ms: number | null;
    started_at: string;
    completed_at: string;
  }>;
  return recommendSubagentBudgets(rows.map((row) => ({
    profile: row.profile,
    turns: row.turns,
    logicalOperations: row.logical_operations,
    elapsedMs: row.elapsed_ms ?? 0,
    startedAtMs: Date.parse(`${row.started_at.replace(' ', 'T')}Z`),
    completedAtMs: Date.parse(`${row.completed_at.replace(' ', 'T')}Z`),
  })));
}
