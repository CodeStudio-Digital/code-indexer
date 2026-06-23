import type { ApiContext } from './common.js';

/**
 * Admin operations — provider management, quality/drift dashboards, worker
 * diagnostics, pipeline bindings.
 *
 * Source files (apps/http-api/server/routes/admin/* and admin/*):
 *  - pipeline-bindings.ts, pipeline-telemetry.ts, quality.ts, lsh.ts,
 *    drift.ts, workers.ts
 *  - admin/api-tokens.routes.ts, oauth-clients.routes.ts, audit-log.routes.ts,
 *    mcp-servers-oauth.routes.ts
 *
 * Tier gate: most admin routes are operator-only. In the IDE single-user
 * model they're accessible to the Pro user; in multi-user (v1.1+) they'd
 * require an `admin` role.
 *
 * Many fields are intentionally `unknown` — admin shapes are large and
 * subject to change. Handlers refine.
 */

export interface AdminApi {
  // Provider management (was `apps/http-api/admin/index.ts`)
  providers: {
    list(input: void, ctx: ApiContext): Promise<unknown[]>;
    get(input: { id: string }, ctx: ApiContext): Promise<unknown>;
    upsert(input: { id: string; config: unknown }, ctx: ApiContext): Promise<unknown>;
    delete(input: { id: string }, ctx: ApiContext): Promise<void>;
    refreshModels(input: { id: string }, ctx: ApiContext): Promise<{ updated: number }>;
  };

  // Worker pool diagnostics
  workers: {
    status(input: void, ctx: ApiContext): Promise<{
      // Company orchestrator: workers-only architecture, no env gate
      orchestrator: { enabled: boolean; reason: string | null };
      // Coder runner pool: still env-gated via MCP_CODER_WORKER
      coder: { enabled: boolean; envFlag: boolean; reason: string | null };
      pool?: { active: number; idle: number; peak: number; created: number; terminated: number };
    }>;
  };

  // Quality classifier dashboards
  quality: {
    classifications(input: { since?: string; limit?: number }, ctx: ApiContext): Promise<unknown[]>;
    interventions(input: { since?: string; limit?: number }, ctx: ApiContext): Promise<unknown[]>;
    summary(input: { window_days?: number }, ctx: ApiContext): Promise<unknown>;
  };

  // LSH diagnostics
  lsh: {
    stats(input: { projectId?: number }, ctx: ApiContext): Promise<unknown>;
  };

  // Drift detection
  drift: {
    report(input: { sessionId?: number; recent?: number }, ctx: ApiContext): Promise<unknown>;
  };

  // Pipeline bindings (model assignments per pipeline)
  pipelineBindings: {
    list(input: void, ctx: ApiContext): Promise<unknown[]>;
    set(input: { pipeline: string; provider: string; model: string }, ctx: ApiContext): Promise<void>;
  };

  pipelineTelemetry: {
    recent(input: { limit?: number; pipeline?: string }, ctx: ApiContext): Promise<unknown[]>;
  };

  // API token management (for MCP clients)
  apiTokens: {
    list(input: void, ctx: ApiContext): Promise<unknown[]>;
    create(input: { name: string; scopes?: string[]; expires_in_days?: number }, ctx: ApiContext): Promise<{ token: string; id: string }>;
    revoke(input: { id: string }, ctx: ApiContext): Promise<void>;
  };

  // Audit log
  auditLog: {
    list(input: { since?: string; limit?: number; action?: string }, ctx: ApiContext): Promise<unknown[]>;
  };

  // MCP servers (external) with OAuth
  mcpServers: {
    list(input: void, ctx: ApiContext): Promise<unknown[]>;
    register(input: { name: string; uri: string; oauth?: unknown }, ctx: ApiContext): Promise<unknown>;
    delete(input: { id: string }, ctx: ApiContext): Promise<void>;
    /** Trigger OAuth flow against the remote server. */
    connect(input: { id: string }, ctx: ApiContext): Promise<{ authorizationUrl: string }>;
  };
}
