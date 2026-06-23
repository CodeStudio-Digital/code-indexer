/**
 * Cloudflare Workers AI catalog discovery (engine-side, spec-driven).
 *
 * Lifted from `apps/http-api/admin/model-discovery/cloudflare.ts` — the output
 * is byte-for-byte identical (the equivalence test asserts deepEqual). The
 * only thing read from the spec is `discovery.accountIdFrom` (a TemplateVar):
 * its sources are tried in order — `{from:'extra',key}` reads `cfg.extra[key]`,
 * `{from:'env',key}` reads `process.env[key]`. The account-search URL, Bearer
 * auth, task filtering and context_window parsing are hardcoded the same way
 * the admin discoverX does.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec, TemplateVar } from '@mcp/provider-sdk';

interface CloudflareCatalogModel {
  id?: string;
  name?: string;
  description?: string;
  task?: { id?: string; name?: string };
  properties?: Array<{ property_id?: string; value?: unknown }>;
}

interface CloudflareCatalogResponse {
  result?: CloudflareCatalogModel[];
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
}

const SUPPORTED_TASKS: ReadonlySet<string> = new Set([
  'Text Generation',
  'Text Embeddings',
]);

/** Matches the admin discoverX's hand-written fallback message verbatim. */
const DEFAULT_ACCOUNT_ID_ERROR =
  'Cloudflare provider requires an Account ID. Set extra.account_id on ' +
  'the provider row, or export CLOUDFLARE_ACCOUNT_ID.';

export async function discoverCloudflareModels(
  spec: ProviderSpec,
  cfg: ProviderConfig,
): Promise<UpsertModelInput[]> {
  const accountId = resolveAccountId(spec.discovery?.accountIdFrom, cfg);
  const apiKey = cfg.api_key ?? '';
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=200`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error(`Cloudflare API error: HTTP ${r.status}`);
  const body = (await r.json()) as CloudflareCatalogResponse;
  if (body.success === false) {
    const msg = body.errors?.map((e) => e.message).join('; ') ?? 'unknown';
    throw new Error(`Cloudflare API error: ${msg}`);
  }
  const out: UpsertModelInput[] = [];
  for (const m of body.result ?? []) {
    const id = m.name ?? m.id;
    if (!id || !id.startsWith('@cf/')) continue;
    const task = m.task?.name ?? '';
    if (!SUPPORTED_TASKS.has(task)) continue;
    out.push({
      model_id: id,
      name: id,
      context_window: readContextWindow(m) ?? getRegistryContextWindow(id),
      source: 'live' as const,
    });
  }
  return out;
}

/**
 * Resolve the account id from the spec's TemplateVar — `extra` sources read
 * `cfg.extra[key]` (string, non-empty), `env` sources read `process.env[key]`.
 * Mirrors the admin `readAccountId`: extra wins over env, and a missing value
 * throws an actionable error.
 */
function resolveAccountId(tpl: TemplateVar | undefined, cfg: ProviderConfig): string {
  const sources = tpl?.sources ?? [];
  for (const src of sources) {
    if (src.from === 'extra') {
      const raw = cfg.extra?.[src.key];
      if (typeof raw === 'string' && raw.length > 0) return raw;
    } else {
      const env = process.env[src.key];
      if (env && env.length > 0) return env;
    }
  }
  throw new Error(tpl?.errorMessage ?? DEFAULT_ACCOUNT_ID_ERROR);
}

/**
 * Cloudflare exposes context_size on text-gen models via the `properties`
 * array (entry with property_id="context_window"). Best-effort parse so we get
 * a useful value when present; falls back to the static registry.
 */
function readContextWindow(m: CloudflareCatalogModel): number | null {
  const prop = m.properties?.find((p) => p.property_id === 'context_window');
  if (!prop) return null;
  const v = prop.value;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
