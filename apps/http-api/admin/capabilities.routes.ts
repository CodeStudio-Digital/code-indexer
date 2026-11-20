/**
 * /api/admin/capabilities — visibility for runtime model capability resolution.
 *
 * Phase G — exposes two read-only endpoints that surface where the runtime
 * is falling back to inferred or hardcoded values. The admin UI uses these
 * to render a "Models running with imprecise capabilities" panel so the
 * operator can decide whether to lock in explicit values via the existing
 * /providers/:id/models/:modelId PATCH route.
 *
 * No state is stored here — the fallback tracker is in-memory inside
 * capabilities.ts; the resolver is pure. Restarting the server clears
 * the tracker. That's intentional: a fresh boot starts the dashboard
 * with a clean slate, and any model still falling back will be re-recorded
 * on its next session.
 */
import { HttpRouter } from '@mcp/shared/http/router.js';
import {
  getRecentCapabilityFallbacks,
  resolveContextWindowWithSource,
  getEffectiveContextWindow,
} from '@mcp/code-agent/providers/capabilities.js';

export function capabilitiesRouter(): HttpRouter {
  const app = new HttpRouter();

  /**
   * GET /api/admin/capabilities/fallbacks — list of every model that has
   * resolved via the inferred or hardcoded-fallback path since boot.
   * Sorted most-recent first.
   *
   * Each row contains:
   *   - model: the model_id we resolved
   *   - source: 'inferred' (family heuristic matched) | 'fallback' (hardcoded 128K)
   *   - via: stable rule identifier (e.g., 'family:openai-gpt5')
   *   - window: the resolved token count
   *   - count: times this model was resolved via fallback
   *   - firstSeenAt / lastSeenAt: ms-since-epoch timestamps
   */
  app.get('/capabilities/fallbacks', (c) => {
    return c.json({ fallbacks: getRecentCapabilityFallbacks() });
  });

  /**
   * GET /api/admin/capabilities/resolve?model=X — preview the resolution
   * chain output for an arbitrary model id. Used by the admin UI to show
   * "if you add this model, here's what you'd get" before saving. Does
   * NOT touch the tracker (pure read).
   *
   * Returns:
   *   { window, source, via, effective, reservedOutput, isFallback }
   *
   * Note: `resolveContextWindowWithSource` does NOT look at env/DB layers
   * (it's the static-only chain). `getEffectiveContextWindow` includes
   * env/DB and is what the runner actually uses — we surface both so the
   * UI can tell the admin "you already set this in admin (DB)" vs "this
   * came from the family heuristic".
   */
  app.get('/capabilities/resolve', (c) => {
    const model = c.req.query('model') ?? '';
    if (!model) return c.json({ error: 'query param `model` required' }, 400);
    const staticChain = resolveContextWindowWithSource(model);
    const effective = getEffectiveContextWindow(model);
    return c.json({
      model,
      static: staticChain,
      runtime: {
        window: effective.window,
        effective: effective.effective,
        reservedOutput: effective.reservedOutput,
        isFallback: effective.isFallback,
        source: effective.source,
        via: effective.via,
      },
    });
  });

  return app;
}
