/**
 * Pure helpers for the Chrome Service v4.0. All exports here are
 * side-effect-free + cheap to call — keeping them isolated lets the
 * runtime (`ChromeService`), the admin routes, and the QA tools
 * share the same address resolution + error classification without
 * pulling in the lifecycle code.
 *
 * Migrated from `src/core/sandbox/playwright-sidecar.ts` (deleted in
 * v4.0). The shape of `classifyChromeServiceError` is unchanged so
 * existing tests keep passing after the path rename.
 */

/**
 * Default tag for the Chrome Service image. **Must** match the
 * `@playwright/test` version pinned in
 * `playwright-bootstrap.ts:installPlaywrightTestClient` — Playwright's
 * client refuses to connect to a server with a different MAJOR.MINOR
 * (`browserType.connect` throws "Looks like Playwright was just
 * updated…").
 *
 * Updating this tag is a coordinated change:
 *   1. bump this constant
 *   2. bump the pinned client version in playwright-bootstrap.ts
 *   3. operators with a running Chrome Service must restart it from
 *      the Admin Panel so the new image is pulled.
 */
export const DEFAULT_CHROME_SERVICE_IMAGE = 'mcr.microsoft.com/playwright:v1.59.1-jammy';
export const PINNED_PLAYWRIGHT_TEST_VERSION = '1.59.1';

/** Default port the run-server binds inside the container (and via -p on the host). */
export const DEFAULT_CHROME_SERVICE_PORT = 9222;

export type ContainerRuntime = 'docker' | 'podman' | 'e2b' | null | undefined;

/**
 * Pure: choose the host alias the SANDBOX containers must use to reach
 * the Chrome Service running on the host loopback.
 *
 * - **Podman rootless (Linux)** resolves `host.containers.internal` via
 *   `slirp4netns` automatically; no `--add-host` needed.
 * - **Docker Desktop (mac / windows)** resolves `host.docker.internal`
 *   nativamente.
 * - **Docker rootless on bare Linux** historically requires
 *   `--add-host=host.docker.internal:host-gateway`. We still emit
 *   `host.docker.internal` here and the operator adds the flag at the
 *   driver level (caveat documented in the v4.0 plan).
 *
 * Falls back to `host.docker.internal` for `e2b` / null runtimes — the
 * E2B driver doesn't host its own loopback bridge anyway, so this only
 * shows up in tests where the runtime isn't resolved yet.
 */
export function buildHostFacingWsEndpoint(
  runtime: ContainerRuntime,
  port: number = DEFAULT_CHROME_SERVICE_PORT,
): string {
  const host = resolveHostAlias(runtime);
  return `ws://${host}:${port}/`;
}

/**
 * Pure: same alias logic for the HTTP health endpoint. Used by sibling
 * containers that prefer a quick HTTP probe before opening a WebSocket.
 *
 * Note on path: `playwright run-server` answers any GET path with
 * `"Running"` (plain text, 200). It is NOT a CDP server — `chromium.connect()`
 * uses Playwright's own WS protocol, distinct from `chromium.connectOverCDP()`.
 * So the health check is "any 200 from the root", not the CDP `/json/version`.
 */
export function buildHostFacingHealthUrl(
  runtime: ContainerRuntime,
  port: number = DEFAULT_CHROME_SERVICE_PORT,
): string {
  const host = resolveHostAlias(runtime);
  return `http://${host}:${port}/`;
}

/**
 * Pure: the host-loopback URL the http-api process itself uses to
 * probe the run-server. Different from `buildHostFacingHealthUrl`
 * because the host process talks to `127.0.0.1`, not the runtime
 * gateway alias.
 */
export function buildLoopbackHealthUrl(port: number = DEFAULT_CHROME_SERVICE_PORT): string {
  return `http://127.0.0.1:${port}/`;
}

/**
 * Pure: the loopback WS endpoint the http-api process itself uses to
 * connect to the Chrome Service via Playwright.
 *
 * Critically distinct from `buildHostFacingWsEndpoint`:
 *   - `buildHostFacingWsEndpoint(...)` returns `ws://host.containers.internal:<port>/`
 *     — the alias SANDBOX CONTAINERS use to reach the Chrome Service
 *     across the runtime gateway. Resolves via slirp4netns (Podman)
 *     or the Docker Desktop DNS shim.
 *   - `buildLoopbackWsEndpoint(...)` returns `ws://127.0.0.1:<port>/`
 *     — the URL the HOST process uses, because the container alias
 *     does NOT resolve outside containers (`getaddrinfo ENOTFOUND
 *     host.containers.internal`).
 *
 * Used by `ChromeService.connectBrowser` (the doc indexer's force-browser
 * branch + QA tool fall-back when the agent runs from the host). Never
 * hand this URL to a sandbox container — they need the alias.
 */
export function buildLoopbackWsEndpoint(port: number = DEFAULT_CHROME_SERVICE_PORT): string {
  return `ws://127.0.0.1:${port}/`;
}

function resolveHostAlias(runtime: ContainerRuntime): string {
  return runtime === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
}

// ─── Failure classifier ──────────────────────────────────────────

export type ChromeServiceFailureKind =
  | 'image-pull'
  | 'network-unreachable'
  | 'run-server-crash'
  | 'unknown';

/**
 * Pure: classify the most common failure modes the Chrome service
 * container can hit. Used by `chrome-service.ts` to surface a
 * fix-it hint to the operator + the QA agent (via
 * `qa_get_browser_endpoint`).
 *
 * The matchers are intentionally permissive — a slightly different
 * runtime version (podman 4 vs 5, docker variants) emits subtly
 * different wording, and we'd rather over-categorise than miss.
 */
export function classifyChromeServiceError(stderr: string): {
  kind: ChromeServiceFailureKind;
  hint: string;
} {
  const text = (stderr ?? '').toLowerCase();
  if (
    /manifest|pull|registry|denied|unauthorized/.test(text) ||
    /image\s+not\s+found|not\s+found.*image/.test(text)
  ) {
    return {
      kind: 'image-pull',
      hint:
        'The container runtime could not pull the Playwright image. ' +
        'Check network egress (the sandbox squid proxy may need to allow `mcr.microsoft.com`) ' +
        'and retry. Setting `MCP_PLAYWRIGHT_SIDECAR_IMAGE` to a mirrored tag also works.',
    };
  }
  if (/network|dns|getaddrinfo|connect ec.*refused|no route to host/.test(text)) {
    return {
      kind: 'network-unreachable',
      hint:
        'The Chrome service started but is unreachable. Check the host-port binding ' +
        '(default `127.0.0.1:9222`) and the runtime gateway alias ' +
        '(`host.containers.internal` for Podman, `host.docker.internal` for Docker).',
    };
  }
  if (/run-server|playwright.*exited|cannot find module/.test(text)) {
    return {
      kind: 'run-server-crash',
      hint:
        'The Playwright run-server crashed at startup. Inspect the container logs ' +
        '— common causes: image was overridden to a tag without `playwright` package, ' +
        'or its CMD was changed.',
    };
  }
  return {
    kind: 'unknown',
    hint:
      'Chrome service failed to come up. Inspect the container logs for the underlying cause.',
  };
}
