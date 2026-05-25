/**
 * Admin routes for the env-var catalog (migration 105 + app_settings).
 *
 *   GET    /api/admin/settings              → catalog + resolved values
 *   PUT    /api/admin/settings              → bulk update { key: value | null }
 *   POST   /api/admin/settings/restart      → re-exec the http-api process
 *
 * The bulk PUT is intentional — the admin UI buffers edits locally and
 * sends them in one shot when the operator hits "Save", so we get a
 * single transactional write and a single audit event per save.
 */
import { Hono } from 'hono';
import { AppSettingsStore } from '@mcp/store/app-settings-store.js';
import { APP_SETTINGS, SETTING_CATEGORIES, getSettingDef } from '@mcp/store/app-settings-catalog.js';

/**
 * Hook the Electron main sets at boot so a settings-driven restart
 * becomes `app.relaunch() + app.exit(0)` instead of `process.exit(75)`.
 * Standalone dev mode (no Electron) leaves the hook null and we fall
 * back to the exit-code-75 path supervisors understand.
 */
let restartHook: (() => void) | null = null;
export function setSettingsRestartHook(fn: (() => void) | null): void {
  restartHook = fn;
}

export function createAppSettingsRouter(dbPath: string): Hono {
  const app = new Hono();

  app.get('/settings', (c) => {
    const store = new AppSettingsStore(dbPath);
    try {
      const resolved = store.resolveAll();
      // Don't ship the raw secret value to the dashboard. We send a
      // boolean `hasValue` flag so the input can render "•••••" /
      // "saved" without leaking. Operator can still overwrite by
      // typing a fresh value; clearing the input + saving wipes the row.
      const items = resolved.map((r) => {
        const isSecret = r.def.type === 'secret';
        return {
          key: r.def.key,
          label: r.def.label,
          description: r.def.description,
          type: r.def.type,
          category: r.def.category,
          advanced: !!r.def.advanced,
          restartNeeded: !!r.def.restartNeeded,
          options: r.def.options,
          min: r.def.min,
          max: r.def.max,
          default: r.def.default ?? null,
          source: r.source,
          updatedAt: r.updatedAt,
          // Secrets get hasValue+effectiveValueMasked instead of the raw value.
          ...(isSecret
            ? {
                hasValue: r.effectiveValue !== null && r.effectiveValue !== '',
                value: null,
              }
            : { value: r.effectiveValue, hasValue: r.effectiveValue !== null }),
        };
      });
      return c.json({
        items,
        categories: SETTING_CATEGORIES,
      });
    } finally {
      store.close();
    }
  });

  app.put('/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { updates?: Record<string, string | null> };
    const updates = body.updates ?? {};
    const keys = Object.keys(updates);
    if (keys.length === 0) return c.json({ error: 'no updates' }, 400);

    // Validate first — refuse the whole batch if any key is unknown.
    const unknown = keys.filter((k) => !getSettingDef(k));
    if (unknown.length > 0) {
      return c.json({ error: 'unknown_settings', keys: unknown }, 400);
    }

    const store = new AppSettingsStore(dbPath);
    let restartNeeded = false;
    try {
      for (const key of keys) {
        const def = getSettingDef(key)!;
        const value = updates[key];
        // Coerce numbers/bools through string before saving — the
        // schema stores everything as TEXT.
        const stringified = value === null || value === undefined ? null : String(value);
        store.set(key, stringified);
        if (def.restartNeeded) restartNeeded = true;
      }
      return c.json({
        ok: true,
        updated: keys.length,
        restartNeeded,
        appliedToProcessEnv: keys.length,
      });
    } finally {
      store.close();
    }
  });

  /**
   * Re-exec the process so cached env reads (e.g., `const PORT =
   * Number(process.env.MCP_API_PORT)` at module top) pick up new
   * values. Electron's main process restarts the http-api child;
   * standalone dev mode just sets exit code and lets the caller
   * (nodemon, foreman) bring us back up.
   */
  app.post('/settings/restart', async (c) => {
    // Reply BEFORE restarting so the admin UI gets the 202.
    setTimeout(() => {
      if (restartHook) {
        console.log('[app-settings] restart requested by admin — calling Electron relaunch hook');
        try {
          restartHook();
        } catch (e) {
          console.error(
            `[app-settings] restart hook threw: ${e instanceof Error ? e.message : String(e)}`,
          );
          process.exit(75);
        }
      } else {
        console.log('[app-settings] restart requested by admin — exiting with code 75');
        // Exit code 75 ("EX_TEMPFAIL") signals "transient failure, please
        // restart me" to a supervisor (nodemon, foreman, systemd).
        process.exit(75);
      }
    }, 100);
    return c.json({ ok: true, message: 'restart in 100ms' }, 202);
  });

  return app;
}

/** Re-export for the dashboard so it can import types from one place. */
export { APP_SETTINGS };
