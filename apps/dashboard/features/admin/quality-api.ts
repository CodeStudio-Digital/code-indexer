/**
 * Admin API client for quality + counterfactual endpoints.
 */

export type QualityVerdict = 'ok' | 'warn' | 'flagged' | 'error';

export interface QualityRow {
  id: number;
  session_id: number | null;
  company_session_id: number | null;
  agent_run_id: number | null;
  message_id: string | null;
  assessment_id: string | null;
  round_message_id: number | null;
  scope: 'run_final' | 'runtime' | 'legacy_turn';
  source: 'terminal_llm' | 'deterministic_guard' | 'legacy_llm';
  action_taken: 'none' | 'advisory' | 'tool_call_refused' | 'strategy_nudge';
  evidence_json: string | null;
  classifier_name: string;
  verdict: QualityVerdict;
  system_error: 0 | 1;
  confidence: number | null;
  reason: string | null;
  provider_id: string | null;
  model_id: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  provider_requests: number;
  created_at: string;
}

export interface VerdictDistribution {
  classifier_name: string;
  verdict: QualityVerdict;
  count: number;
}

export interface CounterfactualRow {
  id: number;
  pipeline_name: string;
  shadow_variant: string;
  query_hash: string;
  production_choice_json: string | null;
  shadow_prediction_json: string | null;
  true_outcome_json: string | null;
  outcome_confidence: number | null;
  outcome_observed_at: string | null;
  created_at: string;
}

export interface CounterfactualStats {
  totalRows: number;
  withOutcome: number;
  pendingOutcome: number;
  perVariant: Array<{ pipeline_name: string; shadow_variant: string; count: number; with_outcome: number }>;
}

export interface QualityStatus {
  enabled: boolean;
  desiredEnabled: boolean;
  mode: 'hybrid';
  target: 'completed_round';
  workers: {
    total: number;
    acknowledged: number;
    failed: number;
    states: Array<{ sessionId: number; enabled: boolean; kind: 'coder' | 'company' }>;
  };
}

export interface QualityOverview {
  completedTasks: number;
  assessments: number;
  llmRequests: number;
  tokensIn: number;
  tokensOut: number;
  averageLatencyMs: number;
  infrastructureFailures: number;
  runtimeIncidents: number;
}

export async function fetchQualityDistribution(opts: {
  classifierName?: string;
  since?: string;
} = {}): Promise<{ distribution: VerdictDistribution[] }> {
  const p = new URLSearchParams();
  if (opts.classifierName) p.set('classifier_name', opts.classifierName);
  if (opts.since)          p.set('since', opts.since);
  const r = await fetch(`/api/admin/quality/distribution?${p.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as { distribution: VerdictDistribution[] };
}

export async function fetchQualityRows(opts: {
  classifierName: string;
  since?: string;
  limit?: number;
}): Promise<{ rows: QualityRow[] }> {
  const p = new URLSearchParams();
  p.set('classifier_name', opts.classifierName);
  if (opts.since) p.set('since', opts.since);
  if (opts.limit) p.set('limit', String(opts.limit));
  const r = await fetch(`/api/admin/quality?${p.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as { rows: QualityRow[] };
}

export async function pruneQuality(cutoff?: string): Promise<{ deleted: number; cutoff: string }> {
  const r = await fetch('/api/admin/quality/prune', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cutoff ? { cutoff } : {}),
  });
  return (await r.json()) as { deleted: number; cutoff: string };
}

/** Wipe ALL quality rows (classifications + interventions). */
export async function clearAllQuality(): Promise<{ deleted: number }> {
  const r = await fetch('/api/admin/quality/prune', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  return (await r.json()) as { deleted: number };
}

/** Read effective hybrid Quality state, including active-worker ACKs. */
export async function fetchQualityEnabled(): Promise<QualityStatus> {
  const r = await fetch('/api/admin/quality/enabled');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as QualityStatus;
}

/** Toggle terminal delivery assessment at runtime (no restart). */
export async function setQualityEnabled(enabled: boolean): Promise<QualityStatus> {
  const r = await fetch('/api/admin/quality/enabled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as QualityStatus;
}

export async function fetchQualityOverview(since?: string): Promise<QualityOverview> {
  const p = new URLSearchParams();
  if (since) p.set('since', since);
  const r = await fetch(`/api/admin/quality/overview?${p.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as QualityOverview;
}

export async function fetchQualityScopedRows(
  scope: 'delivery' | 'runtime' | 'legacy',
  opts: { since?: string; limit?: number } = {},
): Promise<{ rows: QualityRow[]; distribution?: VerdictDistribution[] }> {
  const p = new URLSearchParams();
  if (opts.since) p.set('since', opts.since);
  if (opts.limit) p.set('limit', String(opts.limit));
  const r = await fetch(`/api/admin/quality/${scope}?${p.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as { rows: QualityRow[]; distribution?: VerdictDistribution[] };
}

export async function fetchCounterfactuals(opts: {
  pipelineName?: string;
  shadowVariant?: string;
  since?: string;
  limit?: number;
} = {}): Promise<{ rows: CounterfactualRow[] }> {
  const p = new URLSearchParams();
  if (opts.pipelineName)  p.set('pipeline_name', opts.pipelineName);
  if (opts.shadowVariant) p.set('shadow_variant', opts.shadowVariant);
  if (opts.since)         p.set('since', opts.since);
  if (opts.limit)         p.set('limit', String(opts.limit));
  const r = await fetch(`/api/admin/counterfactuals?${p.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as { rows: CounterfactualRow[] };
}

export async function fetchCounterfactualStats(opts: { since?: string } = {}): Promise<CounterfactualStats> {
  const p = new URLSearchParams();
  if (opts.since) p.set('since', opts.since);
  const r = await fetch(`/api/admin/counterfactuals/stats?${p.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as CounterfactualStats;
}

// ─── Quality v2, C5 — intervention effectiveness ──────────────────────────

export type InterventionType =
  | 'nudge'
  | 'planning'
  | 'policy_block'
  | 'board_alert'
  | 'nudge_suppressed'
  | 'nudge_holdout';

export type InterventionOutcome =
  | 'improved'
  | 'unchanged'
  | 'worsened'
  | 'pending'
  | null;

export interface InterventionEffectivenessByType {
  intervention_type: InterventionType;
  improved: number;
  unchanged: number;
  worsened: number;
  pending: number;
  measured: number;
  improved_rate: number;
}

export interface InterventionRecent {
  id: number;
  session_id: number | null;
  agent_run_id: number | null;
  turn_fired: number;
  intervention_type: InterventionType;
  outcome: InterventionOutcome;
  triggering_classifiers: string;
  created_at: string;
}

export interface InterventionEffectivenessStats {
  byType: InterventionEffectivenessByType[];
  recent: InterventionRecent[];
}

export async function fetchInterventionEffectiveness(opts: {
  since?: string;
  recentLimit?: number;
} = {}): Promise<InterventionEffectivenessStats> {
  const p = new URLSearchParams();
  if (opts.since) p.set('since', opts.since);
  if (opts.recentLimit) p.set('recent_limit', String(opts.recentLimit));
  const r = await fetch(`/api/admin/quality/interventions/stats?${p.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as InterventionEffectivenessStats;
}
