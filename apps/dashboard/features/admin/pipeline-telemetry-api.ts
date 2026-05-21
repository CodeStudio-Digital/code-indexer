/**
 * API client for the pipeline telemetry endpoints (migration 080).
 */

export type DurationBucket = '0-10ms' | '0-50ms' | '50-500ms' | '500-2500ms' | '2500ms+';
export type SizeBucket = '0-10' | '0-50' | '50-500' | '500-1000' | '1000-2500' | '2500+';

export interface TelemetryRow {
  id: number;
  session_id: number | null;
  company_session_id: number | null;
  pipeline_name: string;
  stage: string;
  component_name: string;
  duration_ms: number;
  duration_bucket: DurationBucket;
  candidates_in: number | null;
  candidates_out: number | null;
  size_bucket: SizeBucket | null;
  cache_hits: number;
  cache_misses: number;
  errors: number;
  diag_json: string | null;
  trace_sampled: boolean;
  created_at: string;
}

export interface HistogramBucket {
  bucket: string;
  count: number;
}

export interface CacheStat {
  pipeline_name: string;
  stage: string;
  component_name: string;
  cache_hits: number;
  cache_misses: number;
  hit_rate: number;
}

export async function fetchTelemetry(opts: {
  pipelineName?: string;
  stage?: string;
  sessionId?: number;
  companySessionId?: number;
  since?: string;
  limit?: number;
} = {}): Promise<{ rows: TelemetryRow[] }> {
  const params = new URLSearchParams();
  if (opts.pipelineName) params.set('pipeline_name', opts.pipelineName);
  if (opts.stage) params.set('stage', opts.stage);
  if (opts.sessionId != null) params.set('session_id', String(opts.sessionId));
  if (opts.companySessionId != null) params.set('company_session_id', String(opts.companySessionId));
  if (opts.since) params.set('since', opts.since);
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const r = await fetch(`/api/admin/telemetry/pipelines?${params.toString()}`);
  return (await r.json()) as { rows: TelemetryRow[] };
}

export async function fetchHistogram(opts: {
  pipelineName?: string;
  stage?: string;
  bucketField: 'duration_bucket' | 'size_bucket';
  since?: string;
}): Promise<{ histogram: HistogramBucket[]; bucketField: string }> {
  const params = new URLSearchParams();
  if (opts.pipelineName) params.set('pipeline_name', opts.pipelineName);
  if (opts.stage) params.set('stage', opts.stage);
  params.set('bucket_field', opts.bucketField);
  if (opts.since) params.set('since', opts.since);
  const r = await fetch(`/api/admin/telemetry/pipelines/histogram?${params.toString()}`);
  return (await r.json()) as { histogram: HistogramBucket[]; bucketField: string };
}

export async function fetchCacheStats(opts: { since?: string } = {}): Promise<{ stats: CacheStat[] }> {
  const params = new URLSearchParams();
  if (opts.since) params.set('since', opts.since);
  const r = await fetch(`/api/admin/telemetry/pipelines/cache-stats?${params.toString()}`);
  return (await r.json()) as { stats: CacheStat[] };
}

export async function prunePipelineTelemetry(cutoff?: string): Promise<{ deleted: number; cutoff: string }> {
  const r = await fetch('/api/admin/telemetry/pipelines/prune', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cutoff ? { cutoff } : {}),
  });
  return (await r.json()) as { deleted: number; cutoff: string };
}
