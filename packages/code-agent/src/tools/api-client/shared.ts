/**
 * Shared helpers for the `api_*` tools: session-context resolution, the
 * per-project cookie jar (so login flows persist across api_run_request
 * calls), and environment resolution.
 */
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ApiClientStore } from '@mcp/store/api-client-store.js';
import { type CookieJar, createJar } from '@mcp/shared/utils/http-engine.js';
import { parseEnvVariables } from '@mcp/services/api-client/request-builder.js';
import { getApiClientStore } from './store-binding.js';

export interface ApiCtx {
  store: ApiClientStore;
  projectId: number;
}

/** Resolve the store + project id, or a human error string. */
export function resolveApiCtx(ctx: ToolContext): ApiCtx | { error: string } {
  ctx.signal?.throwIfAborted();
  ctx.ports?.apiClient?.assertCurrent();
  if (ctx.ports?.apiClient && ctx.ports.apiClient.projectId !== ctx.projectId) return { error: 'API client project changed during this attempt.' };
  const store = getApiClientStore();
  if (!store) return { error: 'API client store is not wired in this process.' };
  if (ctx.projectId == null) return { error: 'No project is bound to this session.' };
  return { store, projectId: ctx.projectId };
}

/** IDs are shared across projects; knowing an ID never grants access to it. */
export function projectCollection(ctx: ApiCtx, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = ctx.store.getCollection(id);
  return row?.project_id === ctx.projectId ? row : null;
}

export function projectRequest(ctx: ApiCtx, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = ctx.store.getRequest(id);
  return row && projectCollection(ctx, row.collection_id) ? row : null;
}

const jars = new Map<number, CookieJar>();
export function jarForProject(projectId: number): CookieJar {
  let j = jars.get(projectId);
  if (!j) { j = createJar(); jars.set(projectId, j); }
  return j;
}

/** Resolve base URL + flattened variables for a request, from the chosen or default env. */
export function resolveEnvFor(
  store: ApiClientStore,
  projectId: number,
  envId?: number,
): { baseUrl: string; variables: Record<string, string>; envId: number | null } | { error: string } {
  const env = envId != null ? store.getEnvironment(envId) : store.getDefaultEnvironment(projectId);
  if ((envId != null && (!Number.isSafeInteger(envId) || envId <= 0 || !env))
    || (env && env.project_id !== projectId)) return { error: 'Environment not found in this project.' };
  return { baseUrl: env?.base_url ?? '', variables: parseEnvVariables(env?.variables_json), envId: env?.id ?? null };
}
