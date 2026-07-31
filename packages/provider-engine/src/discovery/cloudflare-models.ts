/**
 * Cloudflare Workers AI catalog discovery (engine-side, spec-driven).
 *
 * The only thing read from the spec is `discovery.accountIdFrom` (a TemplateVar):
 * its sources are tried in order — `{from:'extra',key}` reads `cfg.extra[key]`,
 * `{from:'env',key}` reads `process.env[key]`. The account-search URL, Bearer
 * auth, task filtering and context_window parsing are provider-specific here.
 */
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec, TemplateVar } from '@mcp/provider-sdk';

interface CloudflareCatalogModel {
  id?: string;
  name?: string;
  display_name?: string;
  description?: string;
  task?: { id?: string; name?: string };
  properties?: CloudflareCatalogProperty[];
  deprecated?: boolean;
  planned_deprecation_date?: string | null;
}

interface CloudflareCatalogProperty {
  property_id?: string;
  name?: string;
  value?: unknown;
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
    const metadata = cloudflareModelMetadata(m, id);
    out.push({
      model_id: id,
      name: m.display_name ?? id,
      display_name: m.display_name ?? id,
      description: m.description ?? null,
      context_window:
        readPositiveNumberProperty(m, ['context_window', 'context_length', 'context_size'])
        ?? metadata.contextWindow
        ?? getRegistryContextWindow(id),
      default_max_tokens:
        readPositiveNumberProperty(m, ['max_output_tokens', 'max_completion_tokens'])
        ?? null,
      can_reason: readBooleanProperty(m, ['reasoning', 'supports_reasoning'])
        ?? metadata.canReason,
      supports_attachments: readBooleanProperty(m, ['vision', 'supports_vision'])
        ?? metadata.supportsVision,
      supported_reasoning_levels: null,
      default_reasoning_level: null,
      visibility: isDeprecated(m) ? 'hidden' : 'list',
      supported_in_api: true,
      input_modalities: readStringArrayProperty(m, ['input_modalities'])
        ?? (metadata.supportsVision ? ['text', 'image'] : ['text']),
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
function readPositiveNumberProperty(
  m: CloudflareCatalogModel,
  ids: string[],
): number | null {
  for (const id of ids) {
    const value = findProperty(m, id)?.value;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replaceAll(',', ''));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function readBooleanProperty(
  m: CloudflareCatalogModel,
  ids: string[],
): boolean | null {
  for (const id of ids) {
    const value = findProperty(m, id)?.value;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(?:true|yes|supported)$/i.test(value)) return true;
    if (typeof value === 'string' && /^(?:false|no|unsupported)$/i.test(value)) return false;
  }
  return null;
}

function readStringArrayProperty(
  m: CloudflareCatalogModel,
  ids: string[],
): string[] | null {
  for (const id of ids) {
    const value = findProperty(m, id)?.value;
    if (Array.isArray(value)) {
      const strings = value.filter((entry): entry is string => typeof entry === 'string');
      if (strings.length > 0) return strings;
    }
  }
  return null;
}

function findProperty(
  m: CloudflareCatalogModel,
  id: string,
): CloudflareCatalogProperty | undefined {
  return m.properties?.find((property) =>
    (property.property_id ?? property.name)?.toLowerCase() === id.toLowerCase());
}

function isDeprecated(m: CloudflareCatalogModel): boolean {
  if (m.deprecated === true) return true;
  const flag = readBooleanProperty(m, ['deprecated', 'is_deprecated']);
  if (flag != null) return flag;
  if (!m.planned_deprecation_date) return false;
  const timestamp = Date.parse(m.planned_deprecation_date);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function cloudflareModelMetadata(
  _model: CloudflareCatalogModel,
  id: string,
): { contextWindow: number | null; canReason: boolean; supportsVision: boolean } {
  const normalized = id.toLowerCase();
  const contextWindow =
    /(?:kimi-k2\.6|kimi-k2\.7-code|glm-5\.2)/.test(normalized)
      ? 262_144
      : /kimi-k2\.5/.test(normalized)
        ? 256_000
        : /(?:glm-4\.7-flash|gemma-4|llama-4)/.test(normalized)
          ? 131_072
          : null;
  const canReason =
    /(?:kimi-k2\.[567]|glm-(?:4\.7|5\.2)|gpt-oss|gemma-4|nemotron-3|deepseek-r1|qwen3-30b|qwq)/.test(normalized);
  const supportsVision =
    /(?:kimi-k2\.[567]|gemma-4|llama-4-scout|mistral-small-3\.1)/.test(normalized);
  return { contextWindow, canReason, supportsVision };
}
