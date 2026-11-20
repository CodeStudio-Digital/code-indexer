/**
 * Admin routes for the Chrome Service singleton.
 *
 * Endpoints:
 *   GET    /chrome-service           → config + live healthcheck snapshot
 *   PATCH  /chrome-service           → patch enabled/image/host_port
 *                                       (auto-applies enable/disable
 *                                        when `enabled` toggles)
 *   POST   /chrome-service/restart   → disable + enable
 *   POST   /chrome-service/test      → on-demand healthcheck (no state mutation)
 *
 * Follows the same pattern as `mcp-servers.routes.ts`: each route opens
 * a fresh `ChromeServiceStore` per request (no per-request transactions
 * needed; the singleton row is single-writer through the `ChromeService`
 * class). The runtime singleton is grabbed via `tryGetChromeService()`.
 */
import { HttpRouter } from '@mcp/shared/http/router.js';
import { ChromeServiceStore } from '@mcp/store/chrome-service-store.js';
import { tryGetChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import { loadConfig } from '@mcp/shared/utils/config.js';

interface PatchBody {
  enabled?: boolean;
  image?: string;
  host_port?: number;
}

function getStore(): ChromeServiceStore {
  const config = loadConfig();
  return new ChromeServiceStore(config.dbPath);
}

export function chromeServiceRouter(): HttpRouter {
  const app = new HttpRouter();

  app.get('/chrome-service', async (c) => {
    const svc = tryGetChromeService();
    if (svc) {
      const state = await svc.getEndpoint({ probe: true });
      return c.json(state);
    }
    // Service singleton not wired (boot anomaly) — return raw store row.
    const store = getStore();
    try {
      const cfg = store.getConfig();
      return c.json({
        enabled: cfg.enabled,
        status: cfg.status,
        image: cfg.image,
        hostPort: cfg.host_port,
        containerId: cfg.container_id,
        wsEndpoint: '',
        loopbackHealthUrl: '',
        lastError: cfg.last_error ?? 'ChromeService runtime not wired',
        startedAt: cfg.started_at,
        alive: false,
      });
    } finally {
      store.close();
    }
  });

  app.patch('/chrome-service', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as PatchBody;
    const svc = tryGetChromeService();

    // Validate inputs early — store would catch bad types but the
    // error message is opaque (`SQLITE_CONSTRAINT`).
    if (body.host_port !== undefined) {
      if (!Number.isInteger(body.host_port) || body.host_port < 1 || body.host_port > 65535) {
        return c.json({ error: 'host_port must be an integer in [1, 65535]' }, 400);
      }
    }
    if (body.image !== undefined && (typeof body.image !== 'string' || body.image.trim() === '')) {
      return c.json({ error: 'image must be a non-empty string' }, 400);
    }

    const store = getStore();
    try {
      const before = store.getConfig();
      const next = store.patch({
        enabled: body.enabled,
        image: body.image,
        host_port: body.host_port,
      });

      // Side-effects when enabled toggles or critical fields change
      // while running. The runtime singleton is the source of truth
      // for lifecycle — the store is just the persisted intent.
      if (svc) {
        if (body.enabled === true && !before.enabled) {
          // operator turned it on — start
          svc.enable().catch((e) => console.warn(`[chrome-service.routes] enable error: ${e}`));
        } else if (body.enabled === false && before.enabled) {
          // operator turned it off — stop
          svc.disable().catch((e) => console.warn(`[chrome-service.routes] disable error: ${e}`));
        } else if (
          before.status === 'running' &&
          (body.image !== undefined || body.host_port !== undefined) &&
          (body.image !== before.image || body.host_port !== before.host_port)
        ) {
          // running config changed → restart so the new image/port takes effect
          svc.restart().catch((e) => console.warn(`[chrome-service.routes] restart error: ${e}`));
        }
      }

      return c.json(next);
    } finally {
      store.close();
    }
  });

  app.post('/chrome-service/restart', async (c) => {
    const svc = tryGetChromeService();
    if (!svc) return c.json({ error: 'ChromeService runtime not wired' }, 500);
    try {
      const state = await svc.restart();
      return c.json(state);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post('/chrome-service/test', async (c) => {
    const svc = tryGetChromeService();
    if (!svc) return c.json({ error: 'ChromeService runtime not wired' }, 500);
    const state = await svc.getEndpoint({ probe: true });
    return c.json(state);
  });

  return app;
}
