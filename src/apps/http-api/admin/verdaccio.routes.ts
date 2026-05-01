/**
 * Admin routes for the Verdaccio singleton (embedded npm registry).
 *
 * Endpoints:
 *   GET    /verdaccio              → config + live healthcheck snapshot
 *   PATCH  /verdaccio              → patch enabled/image/host_port/upstream_token/max_patch_versions_per_minor
 *                                     (auto-applies enable/disable when `enabled` toggles)
 *   POST   /verdaccio/restart      → disable + enable
 *   POST   /verdaccio/test         → on-demand healthcheck (no state mutation)
 *
 * Mirrors `chrome-service.routes.ts` 1:1.
 */
import { Hono } from 'hono';
import { VerdaccioStore } from '../../../store/verdaccio-store.js';
import { tryGetVerdaccioService } from '../../../core/verdaccio/verdaccio-service.js';
import { loadConfig } from '../../../utils/config.js';

interface PatchBody {
  enabled?: boolean;
  image?: string;
  host_port?: number;
  upstream_token?: string | null;
  max_patch_versions_per_minor?: number;
}

function getStore(): VerdaccioStore {
  const config = loadConfig();
  return new VerdaccioStore(config.dbPath);
}

export function verdaccioRouter(): Hono {
  const app = new Hono();

  app.get('/verdaccio', async (c) => {
    const svc = tryGetVerdaccioService();
    if (svc) {
      const state = await svc.getEndpoint({ probe: true });
      return c.json(state);
    }
    const store = getStore();
    try {
      const cfg = store.getConfig();
      return c.json({
        enabled: cfg.enabled,
        status: cfg.status,
        image: cfg.image,
        hostPort: cfg.host_port,
        containerId: cfg.container_id,
        loopbackUrl: '',
        registryUrl: '',
        lastError: cfg.last_error ?? 'VerdaccioService runtime not wired',
        startedAt: cfg.started_at,
        maxPatchVersionsPerMinor: cfg.max_patch_versions_per_minor,
        alive: false,
      });
    } finally {
      store.close();
    }
  });

  app.patch('/verdaccio', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as PatchBody;
    const svc = tryGetVerdaccioService();

    if (body.host_port !== undefined) {
      if (!Number.isInteger(body.host_port) || body.host_port < 1 || body.host_port > 65535) {
        return c.json({ error: 'host_port must be an integer in [1, 65535]' }, 400);
      }
    }
    if (body.image !== undefined && (typeof body.image !== 'string' || body.image.trim() === '')) {
      return c.json({ error: 'image must be a non-empty string' }, 400);
    }
    if (body.max_patch_versions_per_minor !== undefined) {
      const n = body.max_patch_versions_per_minor;
      if (!Number.isInteger(n) || n < 1 || n > 10000) {
        return c.json({ error: 'max_patch_versions_per_minor must be an integer in [1, 10000]' }, 400);
      }
    }

    const store = getStore();
    try {
      const before = store.getConfig();
      const next = store.patch({
        enabled: body.enabled,
        image: body.image,
        host_port: body.host_port,
        upstream_token: body.upstream_token,
        max_patch_versions_per_minor: body.max_patch_versions_per_minor,
      });

      if (svc) {
        if (body.enabled === true && !before.enabled) {
          svc.enable().catch((e) => console.warn(`[verdaccio.routes] enable error: ${e}`));
        } else if (body.enabled === false && before.enabled) {
          svc.disable().catch((e) => console.warn(`[verdaccio.routes] disable error: ${e}`));
        } else if (
          before.status === 'running' &&
          (body.image !== undefined || body.host_port !== undefined) &&
          (body.image !== before.image || body.host_port !== before.host_port)
        ) {
          svc.restart().catch((e) => console.warn(`[verdaccio.routes] restart error: ${e}`));
        }
      }

      return c.json(next);
    } finally {
      store.close();
    }
  });

  app.post('/verdaccio/restart', async (c) => {
    const svc = tryGetVerdaccioService();
    if (!svc) return c.json({ error: 'VerdaccioService runtime not wired' }, 500);
    try {
      const state = await svc.restart();
      return c.json(state);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post('/verdaccio/test', async (c) => {
    const svc = tryGetVerdaccioService();
    if (!svc) return c.json({ error: 'VerdaccioService runtime not wired' }, 500);
    const state = await svc.getEndpoint({ probe: true });
    return c.json(state);
  });

  return app;
}
