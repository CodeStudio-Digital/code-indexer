/**
 * "Managed" env vars — auto-populated keys agents can rely on without
 * hardcoding anything. Two main families plus the QA preview cookie:
 *
 *   PREVIEW_URL_*   — ABSOLUTE public URL for the browser / external
 *                     tools (goes through the dashboard proxy). Use
 *                     these when the agent's code runs in a user
 *                     browser context or talks to an external caller.
 *
 *   SERVICE_URL_*   — INTERNAL docker network URL (container-to-
 *                     container). Each sandbox service is reachable
 *                     from its siblings by its `service_id` hostname.
 *                     Use these when the agent writes code inside one
 *                     container that fetches another.
 *
 *   PLAYWRIGHT_BASE_URL[_*] / MCP_PREVIEW_COOKIE — QA-specific. Set
 *     only when the session has the `qa-playwright` skill AND the
 *     manager was wired with `setQaPreviewConfig`.
 *
 * Keys are derived from service id: `main` for the primary, then
 * uppercased + non-alphanumeric → `_`. Idempotent: existing user
 * envs outside these prefixes are untouched; managed keys from
 * removed services are pruned.
 *
 * Extracted from `SandboxManager.syncManagedEnvs` so the env-key
 * synthesis can be unit-tested with a fake envStore.
 */
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import {
  mintPreviewToken,
  parseTokenExpiry,
  QA_PREVIEW_TTL_MS,
} from '@apps/http-api/server/routes/preview-auth.js';
import { buildQaPreviewBaseUrl } from '@mcp/services/qa/url-resolver.js';
import { absolutize } from '@mcp/services/sandbox/manager/util/paths.js';
import { resolvePublicBase } from '@mcp/services/sandbox/manager/util/preview-url.js';

export interface ManagedEnvsDeps {
  envStore: CompanySessionEnvStore | null;
  getPrimary: (sessionId: string) => Sandbox | undefined;
  listServices: (sessionId: string) => Sandbox[];
  qaPreviewConfig: {
    httpApiPort: number;
    hasQaPlaywrightSkill: (sessionId: string) => boolean;
  } | null;
  /** Driver runtime hint; null when `resolveDriver` hasn't picked one yet. */
  qaRuntime: 'docker' | 'podman' | 'e2b' | null;
}

/**
 * Compute the desired `PREVIEW_URL_*` / `SERVICE_URL_*` /
 * `PLAYWRIGHT_BASE_URL_*` keys for the session's sandboxes and reconcile
 * them with the env store. Skipped silently when:
 *   - The env store isn't wired.
 */
export async function syncManagedEnvs(
  sessionId: string,
  deps: ManagedEnvsDeps,
): Promise<void> {
  if (!deps.envStore) return;

  const desired = new Map<string, string>();
  const desiredSecret = new Set<string>();
  const publicBase = resolvePublicBase();

  // QA preview routing (v4.3) — gated by both the per-process config
  // (set at boot) AND the session's role assignments having the
  // `qa-playwright` skill. When either is missing we silently skip
  // the family so non-QA sessions don't pay the cost.
  const qaEnabled =
    deps.qaPreviewConfig != null &&
    deps.qaPreviewConfig.hasQaPlaywrightSkill(sessionId);

  const addEntry = (idUpper: string, sb: Sandbox): void => {
    if (sb.previewUrl) {
      desired.set(`PREVIEW_URL_${idUpper}`, absolutize(sb.previewUrl, publicBase));
    }
    // Internal docker network: siblings address each other by
    // service_id hostname on the CONTAINER's dev-server port (not
    // the host-mapped port — the shared network is inside dockerd).
    const hostname = idUpper === 'MAIN' ? 'main' : idUpper.toLowerCase();
    desired.set(`SERVICE_URL_${idUpper}`, `http://${hostname}:${sb.containerPort}`);

    // QA preview URL — Phase C: the http-api proxy is gone, so sibling
    // containers (the Chrome Service) reach the sandbox dev server via
    // the host gateway alias + the sandbox's loopback port directly.
    // The port-allocator binds 127.0.0.1, so this assumes the operator
    // configured rootless Podman / Docker Desktop where the gateway
    // alias can reach host loopback. Operators on plain Linux Docker
    // can override via `MCP_QA_API_BASE` (still honored by
    // `buildQaPreviewBaseUrl` and propagated here).
    if (qaEnabled && sb.previewUrl && sb.hostPort > 0) {
      const url = buildQaPreviewBaseUrl({
        httpApiPort: sb.hostPort,
        runtime: deps.qaRuntime,
        previewPath: '/',
      });
      desired.set(`PLAYWRIGHT_BASE_URL_${idUpper}`, url);
      if (idUpper === 'MAIN') desired.set('PLAYWRIGHT_BASE_URL', url);
    }
  };

  const primary = deps.getPrimary(sessionId);
  if (primary) addEntry('MAIN', primary);
  for (const svc of deps.listServices(sessionId)) {
    const svcId = svc.id.split(':')[1] ?? '';
    if (!svcId) continue;
    const safe = svcId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    addEntry(safe, svc);
  }

  // QA cookie: long-lived HMAC token persisted as `MCP_PREVIEW_COOKIE`.
  // Re-mint when missing OR token has <7 days of headroom — verifying
  // long before expiry so an in-flight Playwright run never hits 401.
  if (qaEnabled) {
    try {
      const existing = deps.envStore
        .list(sessionId)
        .find((r) => r.key === 'MCP_PREVIEW_COOKIE');
      const exp = parseTokenExpiry(existing?.value);
      const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
      const stale = !exp || exp - Date.now() < REFRESH_THRESHOLD_MS;
      const value = stale
        ? mintPreviewToken(sessionId, QA_PREVIEW_TTL_MS).value
        : existing!.value;
      desired.set('MCP_PREVIEW_COOKIE', value);
      desiredSecret.add('MCP_PREVIEW_COOKIE');
    } catch (e) {
      console.warn(
        `[sandbox-manager] mint preview cookie ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  try {
    for (const [key, value] of desired) {
      const isSecret = desiredSecret.has(key);
      await deps.envStore.upsert(sessionId, key, value, isSecret, { source: 'auto' });
    }
    for (const row of deps.envStore.list(sessionId)) {
      const isManaged =
        row.key.startsWith('PREVIEW_URL_') ||
        row.key.startsWith('SERVICE_URL_') ||
        row.key.startsWith('PLAYWRIGHT_BASE_URL_') ||
        row.key === 'PLAYWRIGHT_BASE_URL' ||
        row.key === 'MCP_PREVIEW_COOKIE';
      if (isManaged && !desired.has(row.key)) {
        deps.envStore.delete(sessionId, row.key);
      }
    }
  } catch (e) {
    console.warn(
      `[sandbox-manager] syncManagedEnvs ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
