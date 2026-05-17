/**
 * Cloudflare Workers AI catalog discovery.
 *
 * Hits the public catalog endpoint
 *   GET /accounts/{account_id}/ai/models/search
 * and returns the text-generation + embedding models that are usable from
 * the OpenAI-compatible endpoint we route through. The account id lives
 * in `cfg.extra.account_id` (set via the admin EditDialog or the env
 * fallback used in the provider definition).
 *
 * Image, audio and other non-text tasks are filtered out — the rest of
 * the codebase only knows how to drive chat/embedding shapes.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';

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

export async function discoverCloudflare(cfg: ProviderConfig): Promise<UpsertModelInput[]> {
  const accountId = readAccountId(cfg);
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

function readAccountId(cfg: ProviderConfig): string {
  const raw = cfg.extra?.account_id;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  const env = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  if (env && env.length > 0) return env;
  throw new Error(
    'Cloudflare provider requires an Account ID. Set extra.account_id on ' +
    'the provider row, or export CLOUDFLARE_ACCOUNT_ID.',
  );
}

/**
 * Cloudflare exposes context_size on text-gen models via the `properties`
 * array (entry with property_id="context_window"). Best-effort parse so
 * we get a useful value when present; falls back to the static registry.
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
