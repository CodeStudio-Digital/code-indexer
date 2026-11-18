/** Resolve preview proxy URLs reachable by container-based QA suites. */

type ContainerRuntime = 'docker' | 'podman' | 'e2b' | null | undefined;

export type QaApiHostAlias = 'host.containers.internal' | 'host.docker.internal' | string;

export function resolveQaApiHostAlias(runtime: ContainerRuntime): QaApiHostAlias {
  return runtime === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
}

/**
 * Pure: compute the API base URL the QA agent's container should use
 * to reach http-api. Honors `MCP_QA_API_BASE` for operators on exotic
 * setups (VPN-routed, bare-Linux Docker rootless without `host-gateway`,
 * or any case where the alias DNS doesn't resolve).
 *
 * Returned value never has a trailing slash — callers append the path
 * including `/preview/...`.
 */
export function resolveQaApiBase(opts: {
  httpApiPort: number;
  runtime: ContainerRuntime;
  /**
   * Optional override (defaults to `process.env.MCP_QA_API_BASE`). The
   * parameter form keeps this fully pure so tests don't fight env state.
   */
  override?: string | undefined;
}): string {
  const fromOverride = (opts.override ?? process.env.MCP_QA_API_BASE)?.trim();
  if (fromOverride) return stripTrailingSlash(fromOverride);
  const host = resolveQaApiHostAlias(opts.runtime);
  return `http://${host}:${opts.httpApiPort}`;
}

/**
 * Pure: build the full Playwright `baseURL` for one service.
 *
 * `previewPath` is what `previewPathPrefixOf(sandbox.previewUrl)`
 * returns — `/preview/68/` for primary, `/preview/68/_svc/api/` for
 * secondaries. The function tolerates inputs with or without a leading
 * slash; the result always ends with a single trailing slash so
 * Playwright's `URL` resolution treats relative goto's correctly
 * (`page.goto('/login')` → `<base>login`).
 */
export function buildQaPreviewBaseUrl(opts: {
  httpApiPort: number;
  runtime: ContainerRuntime;
  previewPath: string;
  override?: string | undefined;
}): string {
  const apiBase = resolveQaApiBase({
    httpApiPort: opts.httpApiPort,
    runtime: opts.runtime,
    override: opts.override,
  });
  const path = normalizePath(opts.previewPath);
  return `${apiBase}${path}`;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function normalizePath(p: string): string {
  let out = p.trim();
  if (!out) return '/';
  if (!out.startsWith('/')) out = `/${out}`;
  if (!out.endsWith('/')) out = `${out}/`;
  return out;
}

/**
 * Pure: derive an env-var-safe service id key (uppercase, alphanumerics
 * only). Matches the convention used by `syncManagedEnvs` for
 * `PREVIEW_URL_<ID>` / `SERVICE_URL_<ID>` so the parallel
 * `PLAYWRIGHT_BASE_URL_<ID>` family stays consistent.
 */
export function envSafeServiceKey(serviceId: string): string {
  return serviceId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
}
