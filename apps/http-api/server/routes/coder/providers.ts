import type { HttpRouter } from '@mcp/shared/http/router.js';
import { SUPPORTED_CODER_PROVIDERS } from '@mcp/code-agent/index.js';
import { getDefinition } from '@mcp/services/providers/registry.js';
import type { ServerDeps } from '../../deps.js';

export function mountCoderProvidersRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { providerStore } = deps;

  app.get('/api/coder/providers', (c) => {
    // Enriched shape: DB-backed providers + models, with legacy fallback.
    // The dashboard Chat selector uses `providers[].models[]` when present;
    // older clients that read the flat array keep working via `legacy`.
    const rows = providerStore.listProviders({ enabled: true, use_for_coder: true });
    if (rows.length === 0) {
      return c.json({ providers: SUPPORTED_CODER_PROVIDERS(), legacy: true });
    }
    const enriched = rows.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      is_default: p.is_default,
      has_key: !!p.api_key,
      // Capabilities come from the static provider definition (registry),
      // not the DB — the dashboard uses them to gate UI affordances like the
      // thinking toggle. Forwarded verbatim so adding a new capability there
      // automatically surfaces to the UI.
      capabilities: getDefinition(p.kind)?.capabilities,
      models: providerStore.listModels(p.id, true).map((m) => ({
        id: m.model_id,
        name: m.name,
        mode: m.mode || null,
        context_window: m.context_window,
        default_max_tokens: m.default_max_tokens,
        can_reason: m.can_reason,
        // Reasoning-effort capability — drives the composer effort selector
        // (shown only when supported_reasoning_levels is non-empty). Mirrors
        // the admin ProviderCard gating.
        supported_reasoning_levels: m.supported_reasoning_levels ?? null,
        default_reasoning_level: m.default_reasoning_level ?? null,
      })),
    }));
    return c.json({ providers: enriched, legacy: false });
  });
}
