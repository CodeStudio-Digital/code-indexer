/**
 * Admin routes for the simulated deepThink defaults.
 *
 * Endpoints:
 *   GET    /deepthink   → current defaults (with hardcoded fallbacks merged in)
 *   PUT    /deepthink   → replace the defaults blob
 *
 * Persisted in `app_settings['deepthink_defaults']` as a JSON blob.
 *
 * The dashboard's `DeepThinkPanel` consumes this to let the operator pick
 * the auxiliary provider+model + tuning knobs (timeout, history window,
 * heuristic gate, tool_result behaviour) without touching code.
 *
 * The values flow into the runner via two paths:
 *   1. `apps/http-api/server/routes/coder/stream.ts` reads the defaults
 *      when a /messages request omits `deep_think_model` / `deep_think_provider`,
 *      and forwards them as the effective config for that turn.
 *   2. Company subordinates already pick up `RoleConfig.deepThink*` (a
 *      stronger signal than admin defaults) so the admin panel only
 *      affects chat-individual sessions today.
 */
import { Hono } from 'hono';
import type { ProviderStore, DeepThinkDefaults } from '@mcp/store/provider-store.js';

const HARDCODED_FALLBACK: DeepThinkDefaults = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  timeoutMs: 8000,
  historyWindow: 3,
  minInputTokens: 0,
  preThinkOnToolResults: false,
};

function withFallback(stored: DeepThinkDefaults | null): DeepThinkDefaults {
  if (!stored) return { ...HARDCODED_FALLBACK };
  return {
    provider: stored.provider ?? HARDCODED_FALLBACK.provider,
    model: stored.model ?? HARDCODED_FALLBACK.model,
    timeoutMs: stored.timeoutMs ?? HARDCODED_FALLBACK.timeoutMs,
    historyWindow: stored.historyWindow ?? HARDCODED_FALLBACK.historyWindow,
    minInputTokens: stored.minInputTokens ?? HARDCODED_FALLBACK.minInputTokens,
    preThinkOnToolResults: stored.preThinkOnToolResults ?? HARDCODED_FALLBACK.preThinkOnToolResults,
  };
}

interface PutBody {
  provider?: string | null;
  model?: string | null;
  timeoutMs?: number | null;
  historyWindow?: number | null;
  minInputTokens?: number | null;
  preThinkOnToolResults?: boolean;
}

function validate(body: PutBody): string | null {
  if (body.timeoutMs !== undefined && body.timeoutMs !== null) {
    if (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 500 || body.timeoutMs > 60_000) {
      return 'timeoutMs must be an integer in [500, 60000]';
    }
  }
  if (body.historyWindow !== undefined && body.historyWindow !== null) {
    if (!Number.isInteger(body.historyWindow) || body.historyWindow < 0 || body.historyWindow > 50) {
      return 'historyWindow must be an integer in [0, 50]';
    }
  }
  if (body.minInputTokens !== undefined && body.minInputTokens !== null) {
    if (!Number.isInteger(body.minInputTokens) || body.minInputTokens < 0 || body.minInputTokens > 10_000) {
      return 'minInputTokens must be an integer in [0, 10000]';
    }
  }
  if (body.provider !== undefined && body.provider !== null && typeof body.provider !== 'string') {
    return 'provider must be a string or null';
  }
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string') {
    return 'model must be a string or null';
  }
  return null;
}

export function deepthinkRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.get('/deepthink', (c) => {
    const stored = store.getDeepThinkDefaults();
    // List ALL enabled providers + their enabled models, mirroring the
    // composer session picker (no use_for_general filter — the operator
    // explicitly asked for the full catalog).
    const availableProviders = store
      .listProviders({ enabled: true })
      .map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        models: store.listModels(p.id, true).map((m) => ({
          model_id: m.model_id,
          name: m.name,
        })),
      }));
    return c.json({
      effective: withFallback(stored),
      stored,
      fallback: HARDCODED_FALLBACK,
      availableProviders,
    });
  });

  app.put('/deepthink', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as PutBody;
    const err = validate(body);
    if (err) return c.json({ error: err }, 400);

    const merged: DeepThinkDefaults = {
      provider: body.provider ?? null,
      model: body.model ?? null,
      timeoutMs: body.timeoutMs ?? null,
      historyWindow: body.historyWindow ?? null,
      minInputTokens: body.minInputTokens ?? null,
      preThinkOnToolResults: body.preThinkOnToolResults ?? false,
    };
    store.setDeepThinkDefaults(merged);
    return c.json({
      effective: withFallback(merged),
      stored: merged,
      fallback: HARDCODED_FALLBACK,
    });
  });

  return app;
}
