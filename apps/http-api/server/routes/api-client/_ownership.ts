import type { ApiClientStore } from '@mcp/store/api-client-store.js';
import type { ApiCollection, ApiEnvironment, ApiRequest } from '@mcp/store/api-client-types.js';

/**
 * Cross-project ownership guards for the api-client routes.
 *
 * Every collection/request/environment is looked up by its OWN row id — ids are
 * NOT project-scoped — so after an in-place project switch the client can still
 * hold a stale id from the previous project. Without these guards a stale id
 * lets one project read or mutate another project's resource: editing/deleting a
 * foreign collection/request, and (worst) sending or generating code against
 * another project's base_url and SECRET env variables. Every `:cid`/`:rid`/
 * `:eid` handler must resolve ownership through these helpers and treat a
 * mismatch as "not found".
 *
 * Ownership model (migration 147): `api_collections` and `api_environments`
 * carry a direct `project_id`; `api_requests` does NOT — a request is owned via
 * `request.collection_id → collection.project_id`.
 */

/** The collection iff it belongs to `projectId`, else null. */
export function collectionInProject(
  store: ApiClientStore,
  projectId: number,
  cid: number,
): ApiCollection | null {
  const col = store.getCollection(cid);
  return col && col.project_id === projectId ? col : null;
}

/** The request iff its owning collection belongs to `projectId`, else null. */
export function requestInProject(
  store: ApiClientStore,
  projectId: number,
  rid: number,
): ApiRequest | null {
  const req = store.getRequest(rid);
  if (!req) return null;
  const col = store.getCollection(req.collection_id);
  return col && col.project_id === projectId ? req : null;
}

/** The environment iff it belongs to `projectId`, else null. */
export function environmentInProject(
  store: ApiClientStore,
  projectId: number,
  envId: number,
): ApiEnvironment | null {
  const env = store.getEnvironment(envId);
  return env && env.project_id === projectId ? env : null;
}

/**
 * Resolve the environment to use for a send / codegen / regression run. An
 * explicit `envId` is honored ONLY when it belongs to this project; a foreign
 * (stale) id is treated exactly like "no env" → fall back to the project's
 * default. This is what stops a stale `selectedEnvId` from sending against — or
 * resolving the secrets of — another project's environment. Returns null only
 * when the project has no environment at all.
 */
export function resolveScopedEnv(
  store: ApiClientStore,
  projectId: number,
  envId: number | null | undefined,
): ApiEnvironment | null {
  if (envId != null) {
    const env = environmentInProject(store, projectId, envId);
    if (env) return env;
  }
  return store.getDefaultEnvironment(projectId);
}
