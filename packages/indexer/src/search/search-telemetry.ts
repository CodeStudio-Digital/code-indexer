import {
  appendFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SearchMode } from '@mcp/shared/types.js';

export type SemanticSearchConsumer =
  | 'agent'
  | 'search_everywhere'
  | 'monaco'
  | 'semantic_test'
  | 'api'
  | 'cli'
  | 'benchmark'
  | 'unknown';

export type SemanticQueryClass =
  | 'identifier'
  | 'natural_language'
  | 'concept'
  | 'unknown';

export interface SemanticSearchTelemetryContext {
  requestId: string;
  consumer: SemanticSearchConsumer;
  sessionId?: string;
  companySessionId?: string;
}

export interface SemanticSearchTelemetryEvent {
  schema_version: 1;
  kind: 'search';
  recorded_at: string;
  request_id: string;
  project_id: number;
  consumer: SemanticSearchConsumer;
  query_class: SemanticQueryClass;
  requested_mode: SearchMode;
  planned_mode: 'fts' | 'vector' | 'hybrid';
  effective_mode: 'fts' | 'vector' | 'hybrid';
  generation_id: number | null;
  cache_hit: boolean;
  fallback: boolean;
  result_count: number;
  total_time_ms: number;
  reranker_applied: boolean;
  reranker_failed: boolean;
  session_scoped: boolean;
}

export interface SemanticSearchOutcomeEvent {
  schema_version: 1;
  kind: 'outcome';
  recorded_at: string;
  request_id: string;
  project_id: number;
  outcome: 'opened';
  semantic_win: boolean;
}

type StoredSemanticTelemetryEvent =
  | SemanticSearchTelemetryEvent
  | SemanticSearchOutcomeEvent;

export interface SemanticSearchTelemetrySummary {
  period_days: number;
  total_searches: number;
  semantic_searches: number;
  lexical_searches: number;
  cache_hits: number;
  fallbacks: number;
  reranker_applied: number;
  reranker_failed: number;
  opened_results: number;
  semantic_wins: number;
  p50_ms: number | null;
  p95_ms: number | null;
  consumers: Partial<Record<SemanticSearchConsumer, number>>;
  effective_modes: Partial<Record<'fts' | 'vector' | 'hybrid', number>>;
  last_search_at: string | null;
}

export interface SemanticSearchTelemetrySink {
  emit(event: SemanticSearchTelemetryEvent): void;
  recordOutcome?(event: SemanticSearchOutcomeEvent): void;
  summarize?(
    projectId: number,
    periodDays?: number,
  ): Promise<SemanticSearchTelemetrySummary>;
  flush?(): Promise<void>;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5_000;

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)] ?? null;
}

function emptySummary(periodDays: number): SemanticSearchTelemetrySummary {
  return {
    period_days: periodDays,
    total_searches: 0,
    semantic_searches: 0,
    lexical_searches: 0,
    cache_hits: 0,
    fallbacks: 0,
    reranker_applied: 0,
    reranker_failed: 0,
    opened_results: 0,
    semantic_wins: 0,
    p50_ms: null,
    p95_ms: null,
    consumers: {},
    effective_modes: {},
    last_search_at: null,
  };
}

/**
 * Bounded, project-local semantic-search telemetry.
 *
 * Rows deliberately exclude raw queries, paths and result contents. The file
 * is safe to delete and lives under the already-ignored `.mcp-indexer`
 * directory so observability cannot dirty the user's repository.
 */
export class FileSemanticSearchTelemetryStore
implements SemanticSearchTelemetrySink {
  private readonly pendingByProject = new Map<number, Promise<void>>();

  constructor(
    private readonly resolveProjectRoot: (projectId: number) => string | null,
  ) {}

  emit(event: SemanticSearchTelemetryEvent): void {
    this.enqueue(event.project_id, event);
  }

  recordOutcome(event: SemanticSearchOutcomeEvent): void {
    this.enqueue(event.project_id, event);
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingByProject.values()]);
  }

  async summarize(
    projectId: number,
    periodDays = 30,
  ): Promise<SemanticSearchTelemetrySummary> {
    await this.pendingByProject.get(projectId)?.catch(() => undefined);
    const rows = await this.readRows(projectId);
    const days = Math.max(1, Math.min(365, Math.floor(periodDays)));
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const summary = emptySummary(days);
    const latencies: number[] = [];
    const currentRows = rows.filter((row) => {
      const timestamp = Date.parse(row.recorded_at);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    const recordedSearches = new Set(
      currentRows
        .filter((row): row is SemanticSearchTelemetryEvent => row.kind === 'search')
        .map((row) => row.request_id),
    );

    for (const row of currentRows) {
      if (row.kind === 'outcome') {
        // Ignore stale, malformed or locally-forged outcomes. A useful-result
        // signal only counts when this project recorded the originating search.
        if (!recordedSearches.has(row.request_id)) continue;
        summary.opened_results += row.outcome === 'opened' ? 1 : 0;
        summary.semantic_wins += row.semantic_win ? 1 : 0;
        continue;
      }
      summary.total_searches += 1;
      if (row.effective_mode === 'fts') summary.lexical_searches += 1;
      else summary.semantic_searches += 1;
      if (row.cache_hit) summary.cache_hits += 1;
      if (row.fallback) summary.fallbacks += 1;
      if (row.reranker_applied) summary.reranker_applied += 1;
      if (row.reranker_failed) summary.reranker_failed += 1;
      summary.consumers[row.consumer] = (summary.consumers[row.consumer] ?? 0) + 1;
      summary.effective_modes[row.effective_mode] =
        (summary.effective_modes[row.effective_mode] ?? 0) + 1;
      if (Number.isFinite(row.total_time_ms)) latencies.push(row.total_time_ms);
      if (!summary.last_search_at || row.recorded_at > summary.last_search_at) {
        summary.last_search_at = row.recorded_at;
      }
    }

    summary.p50_ms = percentile(latencies, 0.5);
    summary.p95_ms = percentile(latencies, 0.95);
    return summary;
  }

  private enqueue(
    projectId: number,
    event: StoredSemanticTelemetryEvent,
  ): void {
    const previous = this.pendingByProject.get(projectId) ?? Promise.resolve();
    let task: Promise<void>;
    task = previous
      .catch(() => undefined)
      .then(() => this.append(projectId, event))
      .catch((error) => {
        console.warn(
          `[semantic-search-telemetry] write failed for p${projectId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        if (this.pendingByProject.get(projectId) === task) {
          this.pendingByProject.delete(projectId);
        }
      });
    this.pendingByProject.set(projectId, task);
  }

  private path(projectId: number): string | null {
    const root = this.resolveProjectRoot(projectId);
    return root
      ? join(root, '.mcp-indexer', 'metrics', 'semantic-search.jsonl')
      : null;
  }

  private async append(
    projectId: number,
    event: StoredSemanticTelemetryEvent,
  ): Promise<void> {
    const path = this.path(projectId);
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    const info = await stat(path).catch(() => null);
    if (!info || info.size <= MAX_FILE_BYTES) return;
    const rows = (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_ROWS);
    await writeFile(path, `${rows.join('\n')}\n`, 'utf8');
  }

  private async readRows(
    projectId: number,
  ): Promise<StoredSemanticTelemetryEvent[]> {
    const path = this.path(projectId);
    if (!path) return [];
    const text = await readFile(path, 'utf8').catch(() => '');
    const rows: StoredSemanticTelemetryEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as StoredSemanticTelemetryEvent;
        if (
          value
          && value.schema_version === 1
          && (value.kind === 'search' || value.kind === 'outcome')
          && value.project_id === projectId
        ) {
          rows.push(value);
        }
      } catch {
        // A partial/corrupt line is isolated; later valid rows still count.
      }
    }
    return rows;
  }
}
