/**
 * Upstream model-id → our canonical internal id.
 *
 * Canonical form = the id we store on filesystem turn metrics /
 * request_api_model, lowercased. Upstream lists use vendor-qualified or
 * generic ids (OpenRouter `anthropic/claude-opus-4`, LiteLLM `gpt-4o`,
 * Cloudflare `@cf/baai/bge-m3`). We map them so a model_prices row keys
 * against what estimateCost() looks up.
 *
 * The ALIASES map is the genuinely fiddly part: upstream often publishes a
 * GENERIC family id while our turns log a SPECIFIC build. Each alias is a
 * maintained assumption (dated) — verify against real model_prices rows and
 * pin a 'manual' row if a specific build's price diverges.
 */
const ROUTE_SUFFIXES = [':free', ':beta', ':extended', ':thinking', ':nitro', ':online'];

const ALIASES: Record<string, string> = {
  // 2026-05 — generic family id → the build this IDE actually runs.
  'claude-opus-4': 'claude-opus-4-8',
  'claude-sonnet-4': 'claude-sonnet-4-6',
  'claude-haiku-4': 'claude-haiku-4-5',
  'kimi-k2': 'kimi-k2.6',
  'deepseek-v4': 'deepseek-v4-pro',
};

/** Normalize an upstream id. Returns '' for empty input. */
export function normalizeModelId(rawId: string): string {
  if (!rawId) return '';
  let id = rawId.trim();
  // @cf/... ids ARE our internal Cloudflare ids — keep verbatim (just lower).
  if (!id.startsWith('@cf/')) {
    const slash = id.indexOf('/');
    if (slash >= 0) id = id.slice(slash + 1); // drop vendor namespace
  }
  for (const suffix of ROUTE_SUFFIXES) {
    if (id.endsWith(suffix)) {
      id = id.slice(0, -suffix.length);
      break;
    }
  }
  id = id.toLowerCase();
  return ALIASES[id] ?? id;
}

/**
 * USD-per-token (number or numeric string) → USD per 1,000,000 tokens.
 * Returns null for absent / non-finite / negative values so a missing field
 * stays null rather than becoming 0 (which would read as "free").
 */
export function perTokenToPerMtok(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}
