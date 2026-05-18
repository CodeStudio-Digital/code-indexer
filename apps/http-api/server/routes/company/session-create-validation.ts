/**
 * Type + validation helpers for the `POST /api/company/sessions` body.
 *
 * Extracted from `sessions.ts` so the route file stays under the LOC cap.
 * `validateAllowedModels` is invoked from session create (rejects bad
 * pools) and from session config patch (PATCH /:id/config) — when the
 * latter moves out of `sessions.ts` it can import the same helper.
 */
import type { BuilderStack } from '@mcp/services/sandbox/types.js';
import type { ExternalProjectRuntime } from './sandbox-helpers.js';

export interface CreateSessionBody {
  template_id?: number;
  name: string;
  project_ids: number[];
  project_labels?: Record<number, string>;
  master_provider: string;
  master_model: string;
  role_assignments?: Array<{
    role: string;
    provider: string;
    model: string;
    project_ids: number[];
    tier?: string;
  }>;
  /**
   * When set, flips the session into builder ("v0-style") mode. The
   * company orchestrator provisions an ephemeral OCI sandbox on start,
   * pipes tool writes into it and exposes a live dev-server preview.
   * Absence of this field preserves the traditional company-session flow.
   */
  builder?: {
    stack: BuilderStack;
    /** Per-session CPU/memory/pids override. Partial — any missing field
     *  falls back to process-level defaults (MCP_SANDBOX_* env). */
    limits?: {
      memory?: string;
      cpus?: string;
      pids?: number;
    };
    /** Existing linked project to run via bind-mount + project Dockerfile. */
    main_project_id?: number;
    /** Runtime for existing main project: production Dockerfile or dev package.json. */
    main_project_runtime?: ExternalProjectRuntime;
  };
  /**
   * Curated pool of `(provider, model)` tuples the master is allowed
   * to spawn subordinates with. When present (length > 0), the master's
   * `spawn_subordinate_agent` tool will REFUSE models outside this
   * list; the tool error names the valid options so the master can
   * self-correct on retry. Absence preserves the previous free-form
   * behavior.
   */
  allowed_models?: Array<{
    provider: string;
    model: string;
    label?: string;
    notes?: string;
    is_default?: boolean;
  }>;
}

/**
 * Validate a proposed allowed_models pool + the derived session config:
 *   - Every entry has non-empty provider + model strings.
 *   - At most one entry is marked is_default.
 *   - If the list is non-empty, `master_model` MUST be one of the
 *     entries (otherwise the master can't run).
 *   - If `role_assignments` is also set, every role's (provider, model)
 *     MUST also be in the pool — we refuse to persist a template whose
 *     own assignments can't be spawned.
 */
export function validateAllowedModels(
  pool: NonNullable<CreateSessionBody['allowed_models']>,
  body: Partial<CreateSessionBody>,
): string | null {
  if (pool.length === 0) return null;
  let defaults = 0;
  for (const [i, entry] of pool.entries()) {
    if (!entry.provider?.trim() || !entry.model?.trim()) {
      return `allowed_models[${i}]: provider and model are required`;
    }
    if (entry.is_default) defaults++;
  }
  if (defaults > 1) {
    return `allowed_models has ${defaults} default entries — at most one may be default`;
  }
  const has = (p: string, m: string) =>
    pool.some((e) => e.provider === p && e.model === m);
  if (body.master_provider && body.master_model && !has(body.master_provider, body.master_model)) {
    return (
      `master model '${body.master_provider}/${body.master_model}' is not in allowed_models. ` +
      `Add it to the pool or pick one of: ${pool.map((e) => `${e.provider}/${e.model}`).join(', ')}`
    );
  }
  for (const role of body.role_assignments ?? []) {
    if (!has(role.provider, role.model)) {
      return (
        `role_assignments['${role.role}'] uses '${role.provider}/${role.model}' which is ` +
        `not in allowed_models. Every role must be spawn-able from the pool.`
      );
    }
  }
  return null;
}
