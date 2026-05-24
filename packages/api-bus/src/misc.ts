import type { ApiContext, AsyncStream } from './common.js';

/**
 * Small, single-purpose namespaces grouped here to avoid a sea of
 * 5-line files. Each interface maps to ONE route file.
 *
 * Splitting these into their own modules later is mechanical if they grow.
 */

// ─── costs.ts ────────────────────────────────────────────
// apps/http-api/server/routes/costs.ts

export interface CostsApi {
  byProject(input: { projectId: number; since?: string }, ctx: ApiContext): Promise<{ total_usd: number; by_model: Array<{ model: string; total_usd: number; tokens_in: number; tokens_out: number }> }>;
  bySession(input: { sessionId: number }, ctx: ApiContext): Promise<{ total_usd: number; turns: Array<{ ts: string; usd: number; tokens_in: number; tokens_out: number }> }>;
  summary(input: { since?: string }, ctx: ApiContext): Promise<{ total_usd: number; by_provider: Array<{ provider: string; total_usd: number }> }>;
}

// ─── diff.ts ─────────────────────────────────────────────
// apps/http-api/server/routes/diff.ts

export interface DiffApi {
  twoFiles(input: { projectId: number; pathA: string; pathB: string }, ctx: ApiContext): Promise<{ patch: string }>;
  vsRef(input: { projectId: number; path: string; ref?: string }, ctx: ApiContext): Promise<{ patch: string }>;
}

// ─── graph.ts ────────────────────────────────────────────
// apps/http-api/server/routes/graph.ts

export interface GraphNode { id: string; label: string; kind: string }
export interface GraphEdge { from: string; to: string; kind: string }
export interface GraphApi {
  dependencies(input: { projectId: number; root?: string; maxDepth?: number }, ctx: ApiContext): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
  symbols(input: { projectId: number; symbolId: number }, ctx: ApiContext): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
}

// ─── stats.ts ────────────────────────────────────────────
// apps/http-api/server/routes/stats.ts (per-project stats live on projects.stats)

export interface StatsApi {
  global(input: void, ctx: ApiContext): Promise<{ project_count: number; total_files: number; total_symbols: number; total_loc: number }>;
}

// ─── models.ts ───────────────────────────────────────────
// apps/http-api/server/routes/models.ts

export interface ModelInfo {
  id: string;
  provider: string;
  context_window: number;
  input_cost_per_mtok: number;
  output_cost_per_mtok: number;
  supports_thinking: boolean;
  supports_tools: boolean;
}
export interface ModelsApi {
  list(input: { provider?: string }, ctx: ApiContext): Promise<ModelInfo[]>;
  get(input: { id: string }, ctx: ApiContext): Promise<ModelInfo>;
}

// ─── telemetry.ts ────────────────────────────────────────
// apps/http-api/server/routes/telemetry.ts

export interface TelemetryApi {
  recent(input: { limit?: number; kind?: string }, ctx: ApiContext): Promise<unknown[]>;
  dashboard(input: { window_days?: number }, ctx: ApiContext): Promise<unknown>;
}

// ─── hygiene.ts ──────────────────────────────────────────
// apps/http-api/server/routes/hygiene.ts

export interface HygieneApi {
  status(input: void, ctx: ApiContext): Promise<{ pending_vector_deletes: number; orphan_files: number; orphan_symbols: number }>;
  retryVectorDeletes(input: { max?: number }, ctx: ApiContext): Promise<{ drained: number; failed: number }>;
}

// ─── export.ts ───────────────────────────────────────────
// apps/http-api/server/routes/export.ts

export interface ExportApi {
  session(input: { sessionId: number; format: 'json' | 'markdown' }, ctx: ApiContext): Promise<{ content: string; filename: string }>;
  project(input: { projectId: number; include?: Array<'snapshots' | 'sessions' | 'files'> }, ctx: ApiContext): Promise<{ content: string; filename: string }>;
}

// ─── webhooks.ts ─────────────────────────────────────────
// apps/http-api/server/routes/webhooks.ts (outbound webhook dispatch config)

export interface WebhookConfig {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
}
export interface WebhooksApi {
  list(input: void, ctx: ApiContext): Promise<WebhookConfig[]>;
  create(input: { url: string; events: string[]; secret?: string }, ctx: ApiContext): Promise<WebhookConfig>;
  update(input: { id: number; url?: string; events?: string[]; active?: boolean }, ctx: ApiContext): Promise<WebhookConfig>;
  delete(input: { id: number }, ctx: ApiContext): Promise<void>;
  test(input: { id: number }, ctx: ApiContext): Promise<{ ok: boolean; status?: number; error?: string }>;
}

// ─── config.ts ───────────────────────────────────────────
// apps/http-api/server/routes/config.ts

export interface ConfigApi {
  features(input: void, ctx: ApiContext): Promise<{
    designSystemEnabled: boolean;
    docsEnabled: boolean;
    hostTerminalEnabled: boolean;
    userAuthRequired: boolean;
  }>;
  version(input: void, ctx: ApiContext): Promise<{ version: string; commit?: string }>;
}

// ─── preview-auth.ts ─────────────────────────────────────
// apps/http-api/server/routes/preview-auth.ts (cookie for sandbox preview iframe)

export interface PreviewAuthApi {
  issue(input: { sessionId: number; serviceId: string }, ctx: ApiContext): Promise<{ token: string; expires_at: number }>;
}
