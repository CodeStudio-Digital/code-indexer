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
  classifier_name: string;
  verdict: QualityVerdict;
  confidence: number | null;
  reason: string | null;
  provider_id: string | null;
  model_id: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
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
  | 'nudge_suppressed';

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
