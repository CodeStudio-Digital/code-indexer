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
import { AppSettingsStore, settingsRestartRequired } from '@mcp/store/app-settings-store.js';
import { APP_SETTINGS, SETTING_CATEGORIES, getSettingDef } from '@mcp/store/app-settings-catalog.js';
import { resolveAppRuntimePolicy } from '../runtime-policy.js';
import { InvalidAppSetting } from '@mcp/store/app-settings-validation.js';

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
          ...(r.validationError ? { validationError: r.validationError } : {}),
          // Secrets get hasValue+effectiveValueMasked instead of the raw value.
          ...(isSecret
            ? {
                hasValue: r.effectiveValue !== null && r.effectiveValue !== '',
                value: null,
              }
            : { value: r.validationError ? r.storedValue : r.effectiveValue, hasValue: r.effectiveValue !== null }),
        };
      });
      let runtimePolicy: ReturnType<typeof resolveAppRuntimePolicy> | null = null;
      let runtimePolicyError: string | undefined;
      try { runtimePolicy = resolveAppRuntimePolicy(dbPath); }
      catch { runtimePolicyError = 'invalid_runtime_policy'; }
      return c.json({
        items,
        categories: SETTING_CATEGORIES,
        restartRequired: settingsRestartRequired(),
        runtimePolicy,
        ...(runtimePolicyError ? { runtimePolicyError } : {}),
        runtimePolicyAppliesTo: 'new_attempts_only',
      });
    } finally {
      store.close();
    }
  });

  app.put('/settings', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_body' }, 400);
    const updates = (body as { updates?: unknown }).updates;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return c.json({ error: 'invalid_updates' }, 400);
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
      store.setMany(updates as Record<string, unknown>, (candidate) => {
        // Validate cross-field policy constraints before any SQLite/env mutation.
        try { resolveAppRuntimePolicy(dbPath, { updates: candidate }); }
        catch { throw new InvalidAppSetting('runtimePolicy', 'invalid_runtime_policy'); }
      });
      restartNeeded = settingsRestartRequired();
      return c.json({
        ok: true,
        updated: keys.length,
        restartNeeded,
        appliedToProcessEnv: keys.length,
        runtimePolicyAppliesTo: 'new_attempts_only',
        runtimePolicy: resolveAppRuntimePolicy(dbPath),
      });
    } catch (error) {
      if (error instanceof InvalidAppSetting) {
        return c.json({ error: 'invalid_setting', key: error.key, reason: error.reason }, 400);
      }
      throw error;
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
