/**
 * SQLite-backed TelemetrySink — drains only global pipeline events into the
 * `pipeline_telemetry` table (migration 080). A composite host may attach a
 * separate filesystem sink for events that carry a session UUID.
 *
 * Events are buffered and flushed in batches to amortize SQLite write
 * cost. The default flush interval is 1s, and the buffer also flushes when
 * it reaches `flushThreshold` events.
 *
 * Why not write per-event: SQLite WAL handles many small writes fine, but
 * cumulative overhead on hot pipelines (e.g. tool selection per turn) adds
 * up. Batching keeps the per-event cost ~10× lower.
 */
import type {
  PipelineTelemetryInsert,
  PipelineTelemetryStore,
} from '@mcp/store/pipeline-telemetry-store.js';
import type { TelemetryEvent, TelemetrySink } from './stats.js';

export interface SqliteTelemetrySinkOptions {
  flushIntervalMs?: number;
  flushThreshold?: number;
}

export class SqliteTelemetrySink implements TelemetrySink {
  private buffer: PipelineTelemetryInsert[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;
  private readonly flushThreshold: number;

  constructor(
    private store: PipelineTelemetryStore,
    options: SqliteTelemetrySinkOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.flushThreshold = options.flushThreshold ?? 200;
  }

  emit(event: TelemetryEvent): void {
    // The post-cut SQLite schema deliberately has no session columns. Dropping
    // here also prevents an accidental session event from becoming an
    // unscoped/global row if this sink is reused in a CompositeTelemetrySink.
    if (event.sessionId != null || event.companySessionId != null) return;
    this.buffer.push({
      pipeline_name: event.pipelineName,
      stage: event.stage,
      component_name: event.component,
      duration_ms: event.durationMs,
      duration_bucket: event.durationBucket,
      candidates_in: event.candidatesIn ?? null,
      candidates_out: event.candidatesOut ?? null,
      size_bucket: event.sizeBucket ?? null,
      cache_hits: event.cacheHits ?? 0,
      cache_misses: event.cacheMisses ?? 0,
      errors: event.errors ?? 0,
      diag: event.diag ?? null,
      trace_sampled: event.traceSampled ?? false,
    });
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushIntervalMs);
      // unref so the timer doesn't prevent process exit
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.store.insertMany(batch);
    } catch {
      // Telemetry must never break the caller. Drop the batch on failure.
      // (Could add: console.warn here in dev, but production stays silent.)
    }
  }

  /** Stop the timer and flush any pending rows synchronously. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
