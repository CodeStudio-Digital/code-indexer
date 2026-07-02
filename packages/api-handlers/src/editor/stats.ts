/**
 * Completion quality stats — aggregates pipeline_telemetry rows in JS (the
 * existing list() query pattern; no new SQL). One implementation feeds both
 * the StatusBar chip tooltip and the Admin telemetry panel. Cached 30s so a
 * hovering user doesn't hammer SQLite. Fail-open: any error returns a zeroed
 * result with configured=false semantics preserved.
 */
import type { EditorStatsResult } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { TtlLru } from './completion-context.js';

type StatsDeps = Pick<HandlerDeps, 'db' | 'pipelineProviderResolver' | 'pipelineTelemetryStore'>;

// Module-level (Electron dual-factory).
const statsCache = new TtlLru<EditorStatsResult>(8, 30_000);

const ZERO: Omit<EditorStatsResult, 'configured' | 'model' | 'windowDays'> = {
  requests: 0, shown: 0, accepted: 0, partial: 0, rejected: 0,
  acceptRate: null,
  latency: { p50: null, p90: null },
  statusBreakdown: {},
  endpointSplit: {},
  byModel: [],
  daily: [],
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return Math.round(sorted[idx]!);
}

export async function computeEditorStats(deps: StatsDeps, daysIn: number): Promise<EditorStatsResult> {
  // The telemetry pruner drops rows >30d — clamp so windows stay honest.
  const days = Math.max(1, Math.min(30, Math.round(daysIn) || 7));
  const cacheKey = `stats:${days}`;
  const hit = statsCache.get(cacheKey);
  if (hit) return hit;

  let configured = false;
  let model: string | null = null;
  try {
    const binding = await deps.pipelineProviderResolver.resolveOrNull('editor', 'autocomplete', {});
    configured = !!binding;
    model = binding?.modelId ?? null;
  } catch { /* stays unconfigured */ }

  const result: EditorStatsResult = { configured, model, windowDays: days, ...structuredClone(ZERO) };
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = deps.pipelineTelemetryStore.list({ pipelineName: 'editor', since, limit: 5000 });
    const okLatencies: number[] = [];
    const byModel = new Map<string, { requests: number; shown: number; accepted: number }>();
    const daily = new Map<string, { requests: number; shown: number; accepted: number }>();
    const bump = (map: Map<string, { requests: number; shown: number; accepted: number }>,
      key: string, field: 'requests' | 'shown' | 'accepted') => {
      let e = map.get(key);
      if (!e) { e = { requests: 0, shown: 0, accepted: 0 }; map.set(key, e); }
      e[field]++;
    };

    for (const row of rows) {
      const day = row.created_at.slice(0, 10);
      let diag: Record<string, unknown> = {};
      try { diag = row.diag_json ? JSON.parse(row.diag_json) as Record<string, unknown> : {}; } catch { /* keep {} */ }
      switch (row.stage) {
        case 'autocomplete': {
          result.requests++;
          bump(byModel, row.component_name, 'requests');
          bump(daily, day, 'requests');
          const status = typeof diag.status === 'string' ? diag.status
            : typeof diag.served === 'string' ? 'cached' : 'unknown';
          result.statusBreakdown[status] = (result.statusBreakdown[status] ?? 0) + 1;
          const endpoint = typeof diag.endpoint === 'string' ? diag.endpoint : 'unknown';
          result.endpointSplit[endpoint] = (result.endpointSplit[endpoint] ?? 0) + 1;
          if (row.errors === 0 && status === 'ok') okLatencies.push(row.duration_ms);
          break;
        }
        case 'autocomplete_shown':
          result.shown++;
          bump(byModel, row.component_name, 'shown');
          bump(daily, day, 'shown');
          break;
        case 'autocomplete_accept':
          result.accepted++;
          bump(byModel, row.component_name, 'accepted');
          bump(daily, day, 'accepted');
          break;
        case 'autocomplete_partial':
          result.partial++;
          break;
        case 'autocomplete_reject':
          result.rejected++;
          break;
        default:
          break;
      }
    }

    result.acceptRate = result.shown > 0 ? result.accepted / result.shown : null;
    okLatencies.sort((a, b) => a - b);
    result.latency = { p50: percentile(okLatencies, 0.5), p90: percentile(okLatencies, 0.9) };
    result.byModel = [...byModel.entries()]
      .map(([m, v]) => ({ model: m, ...v }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 8);
    result.daily = [...daily.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, days);
  } catch { /* zeroed sections stay */ }

  statsCache.set(cacheKey, result);
  return result;
}

/** Test hook. */
export function __resetStatsCacheForTests(): void {
  statsCache.clear();
}
