/**
 * PipelineTelemetryStore — persists stage-level traces from the
 * candidate-pipeline framework.
 *
 * Schema is owned by migration 080. Each row is a single stage execution
 * (Source / Hydrator / Filter / Scorer / Selector / SideEffect) emitted via
 * the `@receiveStats` decorator in `packages/candidate-pipeline/src/stats`.
 *
 * Bucketed dimensions follow the convention from `candidate-pipeline/*.rs`
 * (xai-org/x-algorithm):
 *   - duration_bucket: '0-10ms' | '0-50ms' | '50-500ms' | '500-2500ms' | '2500ms+'
 *   - size_bucket:     '0-10'   | '0-50'   | '50-500'   | '500-1000' |
 *                      '1000-2500' | '2500+'
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type DurationBucket =
  | '0-10ms'
  | '0-50ms'
  | '50-500ms'
  | '500-2500ms'
  | '2500ms+';

export type SizeBucket =
  | '0-10'
  | '0-50'
  | '50-500'
  | '500-1000'
  | '1000-2500'
  | '2500+';

export interface PipelineTelemetryRow {
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

export interface PipelineTelemetryInsert {
  session_id?: number | null;
  company_session_id?: number | null;
  pipeline_name: string;
  stage: string;
  component_name: string;
  duration_ms: number;
  duration_bucket: DurationBucket;
  candidates_in?: number | null;
  candidates_out?: number | null;
  size_bucket?: SizeBucket | null;
  cache_hits?: number;
  cache_misses?: number;
  errors?: number;
  diag?: Record<string, unknown> | null;
  trace_sampled?: boolean;
}

export interface PipelineTelemetryHistogramBucket {
  bucket: string;
  count: number;
}

interface RawRow {
  id: number;
  session_id: number | null;
  company_session_id: number | null;
  pipeline_name: string;
  stage: string;
  component_name: string;
  duration_ms: number;
  duration_bucket: string;
  candidates_in: number | null;
  candidates_out: number | null;
  size_bucket: string | null;
  cache_hits: number;
  cache_misses: number;
  errors: number;
  diag_json: string | null;
  trace_sampled: number;
  created_at: string;
}

function mapRow(row: RawRow): PipelineTelemetryRow {
  return {
    id: row.id,
    session_id: row.session_id,
    company_session_id: row.company_session_id,
    pipeline_name: row.pipeline_name,
    stage: row.stage,
    component_name: row.component_name,
    duration_ms: row.duration_ms,
    duration_bucket: row.duration_bucket as DurationBucket,
    candidates_in: row.candidates_in,
    candidates_out: row.candidates_out,
    size_bucket: row.size_bucket as SizeBucket | null,
    cache_hits: row.cache_hits,
    cache_misses: row.cache_misses,
    errors: row.errors,
    diag_json: row.diag_json,
    trace_sampled: row.trace_sampled !== 0,
    created_at: row.created_at,
  };
}

export class PipelineTelemetryStore {
  constructor(private db: DB) {}

  /** Append a single telemetry row. Hot path — must stay cheap (no JSON.stringify of large objects). */
  insert(row: PipelineTelemetryInsert): number {
    const result = this.db
      .prepare(
        `INSERT INTO pipeline_telemetry (
           session_id, company_session_id, pipeline_name, stage, component_name,
           duration_ms, duration_bucket, candidates_in, candidates_out, size_bucket,
           cache_hits, cache_misses, errors, diag_json, trace_sampled
         ) VALUES (
           @session_id, @company_session_id, @pipeline_name, @stage, @component_name,
           @duration_ms, @duration_bucket, @candidates_in, @candidates_out, @size_bucket,
           @cache_hits, @cache_misses, @errors, @diag_json, @trace_sampled
         )`,
      )
      .run({
        session_id: row.session_id ?? null,
        company_session_id: row.company_session_id ?? null,
        pipeline_name: row.pipeline_name,
        stage: row.stage,
        component_name: row.component_name,
        duration_ms: row.duration_ms,
        duration_bucket: row.duration_bucket,
        candidates_in: row.candidates_in ?? null,
        candidates_out: row.candidates_out ?? null,
        size_bucket: row.size_bucket ?? null,
        cache_hits: row.cache_hits ?? 0,
        cache_misses: row.cache_misses ?? 0,
        errors: row.errors ?? 0,
        diag_json: row.diag ? JSON.stringify(row.diag) : null,
        trace_sampled: row.trace_sampled ? 1 : 0,
      });
    return Number(result.lastInsertRowid);
  }

  /** Bulk insert in a single transaction — used by the in-memory buffer flush. */
  insertMany(rows: PipelineTelemetryInsert[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO pipeline_telemetry (
         session_id, company_session_id, pipeline_name, stage, component_name,
         duration_ms, duration_bucket, candidates_in, candidates_out, size_bucket,
         cache_hits, cache_misses, errors, diag_json, trace_sampled
       ) VALUES (
         @session_id, @company_session_id, @pipeline_name, @stage, @component_name,
         @duration_ms, @duration_bucket, @candidates_in, @candidates_out, @size_bucket,
         @cache_hits, @cache_misses, @errors, @diag_json, @trace_sampled
       )`,
    );
    const tx = this.db.transaction((batch: PipelineTelemetryInsert[]) => {
      for (const row of batch) {
        stmt.run({
          session_id: row.session_id ?? null,
          company_session_id: row.company_session_id ?? null,
          pipeline_name: row.pipeline_name,
          stage: row.stage,
          component_name: row.component_name,
          duration_ms: row.duration_ms,
          duration_bucket: row.duration_bucket,
          candidates_in: row.candidates_in ?? null,
          candidates_out: row.candidates_out ?? null,
          size_bucket: row.size_bucket ?? null,
          cache_hits: row.cache_hits ?? 0,
          cache_misses: row.cache_misses ?? 0,
          errors: row.errors ?? 0,
          diag_json: row.diag ? JSON.stringify(row.diag) : null,
          trace_sampled: row.trace_sampled ? 1 : 0,
        });
      }
    });
    tx(rows);
  }

  /** Recent rows for a given pipeline, optionally scoped by session. */
  list(opts: {
    pipelineName?: string;
    stage?: string;
    sessionId?: number;
    companySessionId?: number;
    since?: string;
    limit?: number;
  } = {}): PipelineTelemetryRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.pipelineName) { where.push('pipeline_name = @pipelineName'); params.pipelineName = opts.pipelineName; }
    if (opts.stage)        { where.push('stage = @stage');               params.stage = opts.stage; }
    if (opts.sessionId)    { where.push('session_id = @sessionId');       params.sessionId = opts.sessionId; }
    if (opts.companySessionId) { where.push('company_session_id = @companySessionId'); params.companySessionId = opts.companySessionId; }
    if (opts.since)        { where.push('created_at >= @since');          params.since = opts.since; }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts.limit ?? 500;
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_telemetry ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit}`,
      )
      .all(params) as RawRow[];
    return rows.map(mapRow);
  }

  /** Histogram by `bucket_field` ('duration_bucket' or 'size_bucket'). */
  histogram(opts: {
    pipelineName?: string;
    stage?: string;
    bucketField: 'duration_bucket' | 'size_bucket';
    since?: string;
  }): PipelineTelemetryHistogramBucket[] {
    const where: string[] = [`${opts.bucketField} IS NOT NULL`];
    const params: Record<string, unknown> = {};
    if (opts.pipelineName) { where.push('pipeline_name = @pipelineName'); params.pipelineName = opts.pipelineName; }
    if (opts.stage)        { where.push('stage = @stage');               params.stage = opts.stage; }
    if (opts.since)        { where.push('created_at >= @since');          params.since = opts.since; }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rows = this.db
      .prepare(
        `SELECT ${opts.bucketField} AS bucket, COUNT(*) AS count
         FROM pipeline_telemetry ${whereSql}
         GROUP BY ${opts.bucketField}
         ORDER BY bucket`,
      )
      .all(params) as { bucket: string; count: number }[];
    return rows;
  }

  /** Cache hit/miss aggregation per pipeline. */
  cacheStats(opts: { since?: string } = {}): Array<{
    pipeline_name: string;
    stage: string;
    component_name: string;
    cache_hits: number;
    cache_misses: number;
    hit_rate: number;
  }> {
    const where: string[] = ['(cache_hits + cache_misses) > 0'];
    const params: Record<string, unknown> = {};
    if (opts.since) { where.push('created_at >= @since'); params.since = opts.since; }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rows = this.db
      .prepare(
        `SELECT pipeline_name, stage, component_name,
                SUM(cache_hits) AS cache_hits,
                SUM(cache_misses) AS cache_misses
         FROM pipeline_telemetry ${whereSql}
         GROUP BY pipeline_name, stage, component_name
         ORDER BY pipeline_name, stage, component_name`,
      )
      .all(params) as Array<{ pipeline_name: string; stage: string; component_name: string; cache_hits: number; cache_misses: number }>;
    return rows.map((r) => ({
      ...r,
      hit_rate: r.cache_hits + r.cache_misses > 0
        ? r.cache_hits / (r.cache_hits + r.cache_misses)
        : 0,
    }));
  }

  /** Prune rows older than the cutoff. Run periodically. */
  pruneOlderThan(cutoff: string): number {
    const result = this.db
      .prepare('DELETE FROM pipeline_telemetry WHERE created_at < ?')
      .run(cutoff);
    return Number(result.changes);
  }
}

/** Map a raw duration in ms to its bucket label. */
export function durationToBucket(ms: number): DurationBucket {
  if (ms < 10) return '0-10ms';
  if (ms < 50) return '0-50ms';
  if (ms < 500) return '50-500ms';
  if (ms < 2500) return '500-2500ms';
  return '2500ms+';
}

/** Map a raw size to its bucket label. */
export function sizeToBucket(n: number): SizeBucket {
  if (n < 10) return '0-10';
  if (n < 50) return '0-50';
  if (n < 500) return '50-500';
  if (n < 1000) return '500-1000';
  if (n < 2500) return '1000-2500';
  return '2500+';
}
