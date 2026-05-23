/**
 * ProviderStore — persists the admin-configurable LLM providers, their API
 * keys, live/hardcoded model lists, OAuth tokens and embedding backends.
 *
 * Schema is owned by migration 006. This class only does CRUD plus one
 * bootstrap helper (seedFromEnvIfEmpty) that migrates legacy .env-based
 * providers into provider_configs on first run, so users upgrading don't lose
 * their existing configuration.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { listDefinitions as listProviderDefinitions } from '@mcp/services/providers/registry.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

/**
 * Logical kind of a provider — drives which adapter is instantiated.
 *
 * This is a runtime-validated string now: the provider registry at
 * `src/core/providers/registry.ts` is the source of truth for valid
 * shapes. The union listed below is kept as a docstring for the known
 * built-ins so IDE autocompletion still shows something useful.
 *
 * Known built-ins: 'anthropic' | 'claude-code' | 'openai' | 'gemini' | 'bedrock' | 'copilot' | 'chatgpt' | 'deepseek' | 'zai' | 'kimi-code'
 */
export type ProviderKind = string;

/** How credentials are supplied. */
export type AuthMode = 'api_key' | 'oauth' | 'aws_sigv4';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  api_key: string | null;
  auth_mode: AuthMode;
  enabled: boolean;
  use_for_agent: boolean;
  use_for_coder: boolean;
  /**
   * When true this provider is eligible as the backend for "general AI"
   * utilities (commit message suggestions, etc). The actual (provider, model)
   * selection lives in `app_settings['general_default_model']`.
   */
  use_for_general: boolean;
  is_default: boolean;
  /** Parsed JSON blob. Free-form per-kind (aws_region, zai_has_coding_mode, ...). */
  extra: Record<string, unknown>;
  /** ID of the fallback provider to switch to on persistent errors. */
  fallback_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderModel {
  provider_id: string;
  model_id: string;
  /** '' = provider doesn't distinguish modes; 'normal'|'coding' used by ZAI. */
  mode: string;
  name: string;
  context_window: number | null;
  default_max_tokens: number | null;
  can_reason: boolean;
  supports_attachments: boolean;
  enabled: boolean;
  /** 'manual' | 'live' (from provider API) | 'hardcoded' (legacy fallback). */
  source: string;
  updated_at: string;
  // Rich metadata (added in migration 052) — populated by providers that
  // expose it (currently ChatGPT/Codex). Null for everything else.
  display_name: string | null;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: string[] | null;
  apply_patch_tool_type: string | null;
  available_in_plans: string[] | null;
  minimal_client_version: string | null;
  visibility: string | null;
  supported_in_api: boolean | null;
  input_modalities: string[] | null;
}

export interface OAuthTokenRow {
  provider_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
  extra: Record<string, unknown>;
  updated_at: string;
}

/**
 * Operator-pinned defaults for the simulated deepThink mode. When the chat
 * composer toggles `deepthink+` without overriding fields in the request
 * body, the runner reads these to pick the auxiliary model + tuning knobs.
 * `provider` + `model` are required to actually fire deepThink — null means
 * "fall back to hardcoded Haiku default in resolveAuxProvider()".
 */
export interface DeepThinkDefaults {
  provider: string | null;
  model: string | null;
  /** Hard timeout for the auxiliary call (ms). Default 8000 when null. */
  timeoutMs: number | null;
  /** How many <thinking data-source="aux"> blocks to keep in history. Default 3. */
  historyWindow: number | null;
  /** Skip auxiliary when last user text is shorter than this (~chars/4). Default 0 (no filter). */
  minInputTokens: number | null;
  /** Run pre-think on tool_result turns too. Default false. */
  preThinkOnToolResults: boolean;
}

export type EmbeddingKind = 'cloudflare' | 'bedrock' | 'null';

export interface EmbeddingConfigRow {
  id: string;
  kind: EmbeddingKind;
  name: string;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

/**
 * Vector store backends. Decoupled from EmbeddingKind because a user can
 * generate embeddings with Bedrock Titan and store them in Qdrant, or embed
 * with Cloudflare BGE-M3 and store in Pinecone, etc.
 *
 * Known kinds: 'cloudflare' (Vectorize worker), 'qdrant' (REST),
 * 'bedrock-opensearch' (planned), 'pinecone' (planned).
 */
export type VectorStoreKind = 'cloudflare' | 'qdrant' | 'bedrock-opensearch' | 'pinecone' | 'null';

export interface VectorStoreConfigRow {
  id: string;
  kind: VectorStoreKind;
  name: string;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

interface ProviderConfigRaw {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  api_key: string | null;
  auth_mode: string;
  enabled: number;
  use_for_agent: number;
  use_for_coder: number;
  use_for_general: number;
  is_default: number;
  extra: string | null;
  fallback_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProviderModelRaw {
  provider_id: string;
  model_id: string;
  mode: string;
  name: string;
  context_window: number | null;
  default_max_tokens: number | null;
  can_reason: number;
  supports_attachments: number;
  enabled: number;
  source: string;
  updated_at: string;
  display_name: string | null;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: string | null;
  apply_patch_tool_type: string | null;
  available_in_plans: string | null;
  minimal_client_version: string | null;
  visibility: string | null;
  supported_in_api: number | null;
  input_modalities: string | null;
}

interface OAuthTokenRaw {
  provider_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
  extra: string | null;
  updated_at: string;
}

interface EmbeddingConfigRaw {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  is_default: number;
  config: string;
  updated_at: string;
}

interface VectorStoreConfigRaw {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  is_default: number;
  config: string;
  updated_at: string;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function hydrateProvider(r: ProviderConfigRaw): ProviderConfig {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as ProviderKind,
    base_url: r.base_url,
    api_key: r.api_key,
    auth_mode: r.auth_mode as AuthMode,
    enabled: !!r.enabled,
    use_for_agent: !!r.use_for_agent,
    use_for_coder: !!r.use_for_coder,
    use_for_general: !!r.use_for_general,
    is_default: !!r.is_default,
    extra: parseJson<Record<string, unknown>>(r.extra, {}),
    fallback_provider_id: r.fallback_provider_id ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function normalizeStoredLevels(levels: unknown[] | null): string[] | null {
  if (!levels) return null;
  const result: string[] = [];
  for (const lv of levels) {
    if (typeof lv === 'string') {
      result.push(lv);
    } else if (lv && typeof lv === 'object' && 'effort' in lv && typeof (lv as Record<string, unknown>).effort === 'string') {
      result.push((lv as Record<string, unknown>).effort as string);
    }
  }
  return result.length > 0 ? result : null;
}

function hydrateModel(r: ProviderModelRaw): ProviderModel {
  return {
    provider_id: r.provider_id,
    model_id: r.model_id,
    mode: r.mode,
    name: r.name,
    context_window: r.context_window,
    default_max_tokens: r.default_max_tokens,
    can_reason: !!r.can_reason,
    supports_attachments: !!r.supports_attachments,
    enabled: !!r.enabled,
    source: r.source,
    updated_at: r.updated_at,
    display_name: r.display_name,
    description: r.description,
    default_reasoning_level: r.default_reasoning_level,
    supported_reasoning_levels: normalizeStoredLevels(parseJson<unknown[] | null>(r.supported_reasoning_levels, null)),
    apply_patch_tool_type: r.apply_patch_tool_type,
    available_in_plans: parseJson<string[] | null>(r.available_in_plans, null),
    minimal_client_version: r.minimal_client_version,
    visibility: r.visibility,
    supported_in_api: r.supported_in_api === null ? null : !!r.supported_in_api,
    input_modalities: parseJson<string[] | null>(r.input_modalities, null),
  };
}

function hydrateOAuth(r: OAuthTokenRaw): OAuthTokenRow {
  return {
    provider_id: r.provider_id,
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_at,
    scope: r.scope,
    extra: parseJson<Record<string, unknown>>(r.extra, {}),
    updated_at: r.updated_at,
  };
}

function hydrateEmbedding(r: EmbeddingConfigRaw): EmbeddingConfigRow {
  return {
    id: r.id,
    kind: r.kind as EmbeddingKind,
    name: r.name,
    enabled: !!r.enabled,
    is_default: !!r.is_default,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    updated_at: r.updated_at,
  };
}

function hydrateVectorStore(r: VectorStoreConfigRaw): VectorStoreConfigRow {
  return {
    id: r.id,
    kind: r.kind as VectorStoreKind,
    name: r.name,
    enabled: !!r.enabled,
    is_default: !!r.is_default,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    updated_at: r.updated_at,
  };
}

export interface UpsertProviderInput {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url?: string | null;
  api_key?: string | null;
  auth_mode?: AuthMode;
  enabled?: boolean;
  use_for_agent?: boolean;
  use_for_coder?: boolean;
  use_for_general?: boolean;
  is_default?: boolean;
  extra?: Record<string, unknown>;
}

export interface UpsertModelInput {
  model_id: string;
  mode?: string;
  name: string;
  context_window?: number | null;
  default_max_tokens?: number | null;
  can_reason?: boolean;
  supports_attachments?: boolean;
  /**
   * Force the `enabled` flag. When undefined, `replaceModelsFromSource`
   * preserves the existing DB value for known rows (admin toggles survive)
   * and uses `default_enabled` (or `true`) for newly seen rows.
   */
  enabled?: boolean;
  /**
   * Default `enabled` value for rows that don't yet exist in the DB. Only
   * read when `enabled` is undefined and there's no prior row. Use this
   * from live discovery to disable hidden / non-API models on first sight
   * without overriding subsequent admin toggles.
   */
  default_enabled?: boolean;
  source?: string;
  // Rich metadata fields (migration 052). All optional — pass null to
  // explicitly clear, omit to leave at NULL.
  display_name?: string | null;
  description?: string | null;
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: string[] | null;
  apply_patch_tool_type?: string | null;
  available_in_plans?: string[] | null;
  minimal_client_version?: string | null;
  visibility?: string | null;
  supported_in_api?: boolean | null;
  input_modalities?: string[] | null;
}

export class ProviderStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrInstance: string | DB) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  // ─── Providers ────────────────────────────────────────────────

  listProviders(filter?: { use_for_coder?: boolean; use_for_agent?: boolean; use_for_general?: boolean; enabled?: boolean }): ProviderConfig[] {
    const clauses: string[] = [];
    if (filter?.enabled !== undefined) clauses.push(`enabled = ${filter.enabled ? 1 : 0}`);
    if (filter?.use_for_coder !== undefined) clauses.push(`use_for_coder = ${filter.use_for_coder ? 1 : 0}`);
    if (filter?.use_for_agent !== undefined) clauses.push(`use_for_agent = ${filter.use_for_agent ? 1 : 0}`);
    if (filter?.use_for_general !== undefined) clauses.push(`use_for_general = ${filter.use_for_general ? 1 : 0}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM provider_configs ${where} ORDER BY name`)
      .all() as ProviderConfigRaw[];
    return rows.map(hydrateProvider);
  }

  /**
   * Return the default enabled provider, or the first enabled provider if none
   * is explicitly marked as default. Returns null when no providers are configured.
   */
  getDefaultProvider(): ProviderConfig | null {
    const row = this.db
      .prepare('SELECT * FROM provider_configs WHERE is_default = 1 AND enabled = 1 LIMIT 1')
      .get() as ProviderConfigRaw | undefined;
    if (row) return hydrateProvider(row);
    // Fallback: first enabled provider
    const first = this.db
      .prepare('SELECT * FROM provider_configs WHERE enabled = 1 ORDER BY name LIMIT 1')
      .get() as ProviderConfigRaw | undefined;
    return first ? hydrateProvider(first) : null;
  }

  /**
   * Convenience: return `{ kind, model }` for the default provider, picking
   * the first enabled model when available. Returns `{ kind: 'zai', model: undefined }`
   * as ultimate fallback.
   */
  getDefaultProviderAndModel(): { kind: string; model: string | undefined } {
    const prov = this.getDefaultProvider();
    if (!prov) return { kind: 'zai', model: undefined };
    const models = this.listModels(prov.id, true);
    return { kind: prov.kind, model: models[0]?.model_id };
  }

  getProvider(id: string): ProviderConfig | null {
    const row = this.db
      .prepare('SELECT * FROM provider_configs WHERE id = ?')
      .get(id) as ProviderConfigRaw | undefined;
    return row ? hydrateProvider(row) : null;
  }

  // ─── General AI default (commit messages, prompt utilities, …) ─

  /**
   * Resolve the provider+model to use for "general AI" utilities.
   *
   * Priority:
   *   1. Operator-pinned selection stored in `app_settings['general_default_model']`
   *      (as JSON `{ providerId, modelId }`). Only returned if the provider is
   *      still enabled, still flagged `use_for_general`, and the model is still
   *      enabled.
   *   2. First provider flagged `use_for_general` + its first enabled model.
   *   3. `null` when no provider is eligible.
   */
  getGeneralDefault(): { providerId: string; modelId: string } | null {
    const pinned = this.getAppSetting('general_default_model');
    if (pinned) {
      try {
        const parsed = JSON.parse(pinned) as { providerId?: string; modelId?: string };
        if (parsed.providerId && parsed.modelId) {
          const prov = this.getProvider(parsed.providerId);
          if (prov && prov.enabled && prov.use_for_general) {
            const model = this.listModels(prov.id, true).find((m) => m.model_id === parsed.modelId);
            if (model) return { providerId: prov.id, modelId: model.model_id };
          }
        }
      } catch {
        /* fall through to heuristic */
      }
    }
    const candidates = this.listProviders({ enabled: true, use_for_general: true });
    for (const p of candidates) {
      const m = this.listModels(p.id, true)[0];
      if (m) return { providerId: p.id, modelId: m.model_id };
    }
    return null;
  }

  setGeneralDefault(providerId: string, modelId: string): void {
    this.setAppSetting('general_default_model', JSON.stringify({ providerId, modelId }));
  }

  // ─── deepThink defaults ────────────────────────────────────────
  /**
   * Operator-pinned defaults for the simulated deepThink auxiliary model.
   * When the chat composer toggles `deepthink+` without overriding model
   * via the request body, the runner picks up these defaults. Stored in
   * `app_settings['deepthink_defaults']` as a single JSON blob.
   */
  getDeepThinkDefaults(): DeepThinkDefaults | null {
    const raw = this.getAppSetting('deepthink_defaults');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DeepThinkDefaults;
    } catch {
      return null;
    }
  }

  setDeepThinkDefaults(defaults: DeepThinkDefaults): void {
    this.setAppSetting('deepthink_defaults', JSON.stringify(defaults));
  }

  // ─── app_settings KV ──────────────────────────────────────────

  getAppSetting(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setAppSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }

  /**
   * Walk the fallback_provider_id chain starting from `providerId`.
   * Returns an ordered list of {provider, model} entries for fallback.
   * Stops at null, cycles, or max depth (10) to prevent infinite loops.
   */
  getFallbackChain(providerId: string): Array<{ provider: string; model: string }> {
    const chain: Array<{ provider: string; model: string }> = [];
    const visited = new Set<string>();
    let currentId: string | null = providerId;
    const maxDepth = 10;

    for (let i = 0; i < maxDepth && currentId; i++) {
      const cfg = this.getProvider(currentId);
      if (!cfg || !cfg.fallback_provider_id) break;

      const fallbackId = cfg.fallback_provider_id;
      if (visited.has(fallbackId)) break; // cycle detection
      visited.add(fallbackId);

      const fallbackCfg = this.getProvider(fallbackId);
      if (!fallbackCfg || !fallbackCfg.enabled) break;

      // Get the default model for this provider
      const models = this.listModels(fallbackId);
      const defaultModel = models[0]; // first model as default
      if (!defaultModel) break;

      chain.push({ provider: fallbackId, model: defaultModel.model_id });
      currentId = fallbackId;
    }

    return chain;
  }

  /** Set or clear the fallback provider for a given provider. */
  setFallbackProvider(providerId: string, fallbackProviderId: string | null): void {
    this.db
      .prepare('UPDATE provider_configs SET fallback_provider_id = ?, updated_at = ? WHERE id = ?')
      .run(fallbackProviderId, new Date().toISOString(), providerId);
  }

  upsertProvider(input: UpsertProviderInput): ProviderConfig {
    const now = new Date().toISOString();
    const existing = this.getProvider(input.id);

    if (existing) {
      this.db
        .prepare(
          `UPDATE provider_configs SET
             name = ?, kind = ?, base_url = ?, api_key = ?, auth_mode = ?,
             enabled = ?, use_for_agent = ?, use_for_coder = ?, use_for_general = ?, is_default = ?,
             extra = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name,
          input.kind,
          input.base_url ?? null,
          input.api_key ?? null,
          input.auth_mode ?? 'api_key',
          (input.enabled ?? existing.enabled) ? 1 : 0,
          (input.use_for_agent ?? existing.use_for_agent) ? 1 : 0,
          (input.use_for_coder ?? existing.use_for_coder) ? 1 : 0,
          (input.use_for_general ?? existing.use_for_general) ? 1 : 0,
          (input.is_default ?? existing.is_default) ? 1 : 0,
          JSON.stringify(input.extra ?? existing.extra),
          now,
          input.id
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO provider_configs
             (id, name, kind, base_url, api_key, auth_mode, enabled,
              use_for_agent, use_for_coder, use_for_general, is_default, extra, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.name,
          input.kind,
          input.base_url ?? null,
          input.api_key ?? null,
          input.auth_mode ?? 'api_key',
          (input.enabled ?? true) ? 1 : 0,
          (input.use_for_agent ?? true) ? 1 : 0,
          (input.use_for_coder ?? true) ? 1 : 0,
          (input.use_for_general ?? false) ? 1 : 0,
          (input.is_default ?? false) ? 1 : 0,
          JSON.stringify(input.extra ?? {}),
          now,
          now
        );
    }

    // Enforce single default per (scope). Cheap: only touched on upsert.
    if (input.is_default) {
      this.db
        .prepare('UPDATE provider_configs SET is_default = 0 WHERE id != ? AND is_default = 1')
        .run(input.id);
    }

    return this.getProvider(input.id)!;
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id);
  }

  // ─── Models ───────────────────────────────────────────────────

  listModels(providerId: string, onlyEnabled = false): ProviderModel[] {
    const where = onlyEnabled ? 'AND enabled = 1' : '';
    const rows = this.db
      .prepare(`SELECT * FROM provider_models WHERE provider_id = ? ${where} ORDER BY name, mode`)
      .all(providerId) as ProviderModelRaw[];
    return rows.map(hydrateModel);
  }

  /** Return every model row across all providers. Used to hydrate the in-memory capability cache on startup. */
  listAllModels(): ProviderModel[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_models ORDER BY provider_id, name, mode')
      .all() as ProviderModelRaw[];
    return rows.map(hydrateModel);
  }

  /**
   * Bulk replace models for a provider, scoped to a `source` (e.g. 'live'
   * or 'manual'). Existing rows from other sources are untouched.
   *
   * Admin toggles (`enabled`) are preserved across refreshes: when an input
   * row omits `enabled`, we look up the current value in the DB by
   * (provider_id, model_id, mode) and reuse it. Newly seen models default
   * to `true`. Pass `enabled: true|false` explicitly to override.
   */
  replaceModelsFromSource(providerId: string, source: string, models: UpsertModelInput[]): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const existingRows = this.db
        .prepare(
          'SELECT model_id, mode, enabled, default_reasoning_level FROM provider_models WHERE provider_id = ? AND source = ?'
        )
        .all(providerId, source) as {
          model_id: string;
          mode: string;
          enabled: number;
          default_reasoning_level: string | null;
        }[];
      const existingEnabled = new Map<string, boolean>();
      // Track whether each row existed before (regardless of whether the
      // stored level is null) so we can distinguish "admin explicitly chose
      // auto" (= null, but row existed) from "first time we see the model"
      // (= no entry in this map, fall back to seed default).
      const existingReasoning = new Map<string, string | null>();
      for (const row of existingRows) {
        const key = `${row.model_id}|${row.mode}`;
        existingEnabled.set(key, !!row.enabled);
        existingReasoning.set(key, row.default_reasoning_level);
      }

      this.db
        .prepare('DELETE FROM provider_models WHERE provider_id = ? AND source = ?')
        .run(providerId, source);

      const insert = this.db.prepare(
        `INSERT INTO provider_models
           (provider_id, model_id, mode, name, context_window, default_max_tokens,
            can_reason, supports_attachments, enabled, source, updated_at,
            display_name, description, default_reasoning_level,
            supported_reasoning_levels, apply_patch_tool_type, available_in_plans,
            minimal_client_version, visibility, supported_in_api, input_modalities)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, model_id, mode) DO UPDATE SET
           name = excluded.name,
           context_window = excluded.context_window,
           default_max_tokens = excluded.default_max_tokens,
           can_reason = excluded.can_reason,
           supports_attachments = excluded.supports_attachments,
           enabled = excluded.enabled,
           source = excluded.source,
           updated_at = excluded.updated_at,
           display_name = excluded.display_name,
           description = excluded.description,
           default_reasoning_level = excluded.default_reasoning_level,
           supported_reasoning_levels = excluded.supported_reasoning_levels,
           apply_patch_tool_type = excluded.apply_patch_tool_type,
           available_in_plans = excluded.available_in_plans,
           minimal_client_version = excluded.minimal_client_version,
           visibility = excluded.visibility,
           supported_in_api = excluded.supported_in_api,
           input_modalities = excluded.input_modalities`
      );
      for (const m of models) {
        const mode = m.mode ?? '';
        const key = `${m.model_id}|${mode}`;
        const prev = existingEnabled.get(key);
        const finalEnabled = m.enabled ?? prev ?? m.default_enabled ?? true;
        // If a row existed before, the admin's pick (or explicit `auto` =
        // null) wins over the seed value — same policy as `enabled`. Only
        // newly-seen rows pick up the seed's `default_reasoning_level`.
        const finalReasoningLevel = existingReasoning.has(key)
          ? existingReasoning.get(key) ?? null
          : m.default_reasoning_level ?? null;
        insert.run(
          providerId,
          m.model_id,
          mode,
          m.name,
          m.context_window ?? null,
          m.default_max_tokens ?? null,
          m.can_reason ? 1 : 0,
          m.supports_attachments ? 1 : 0,
          finalEnabled ? 1 : 0,
          m.source ?? source,
          now,
          m.display_name ?? null,
          m.description ?? null,
          finalReasoningLevel,
          m.supported_reasoning_levels ? JSON.stringify(m.supported_reasoning_levels) : null,
          m.apply_patch_tool_type ?? null,
          m.available_in_plans ? JSON.stringify(m.available_in_plans) : null,
          m.minimal_client_version ?? null,
          m.visibility ?? null,
          m.supported_in_api === null || m.supported_in_api === undefined
            ? null
            : m.supported_in_api
              ? 1
              : 0,
          m.input_modalities ? JSON.stringify(m.input_modalities) : null
        );
      }
    });
    tx();
  }

  updateModel(
    providerId: string,
    modelId: string,
    mode: string,
    patch: {
      enabled?: boolean;
      name?: string;
      default_reasoning_level?: string | null;
      context_window?: number | null;
    }
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      args.push(patch.enabled ? 1 : 0);
    }
    if (patch.name !== undefined) {
      sets.push('name = ?');
      args.push(patch.name);
    }
    if (patch.default_reasoning_level !== undefined) {
      sets.push('default_reasoning_level = ?');
      args.push(patch.default_reasoning_level);
    }
    if (patch.context_window !== undefined) {
      sets.push('context_window = ?');
      args.push(patch.context_window);
    }
    if (!sets.length) return;
    sets.push("updated_at = datetime('now')");
    args.push(providerId, modelId, mode);
    this.db
      .prepare(`UPDATE provider_models SET ${sets.join(', ')} WHERE provider_id = ? AND model_id = ? AND mode = ?`)
      .run(...args);
  }

  /**
   * Backfill context_window for every model row that has it null. Pulls the
   * value from the static registry's prefix-aware lookup (capabilities.ts).
   * Returns counts of updated/skipped rows. Cheap, idempotent, no network.
   */
  backfillContextWindowsFromRegistry(
    lookup: (modelId: string) => number | null,
  ): { updated: number; still_null: number; total: number } {
    const rows = this.db
      .prepare(`SELECT provider_id, model_id, mode, context_window FROM provider_models`)
      .all() as Array<{ provider_id: string; model_id: string; mode: string; context_window: number | null }>;
    let updated = 0;
    let stillNull = 0;
    const stmt = this.db.prepare(
      `UPDATE provider_models SET context_window = ?, updated_at = datetime('now')
        WHERE provider_id = ? AND model_id = ? AND mode = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (r.context_window != null) continue;
        const cw = lookup(r.model_id);
        if (cw != null) {
          stmt.run(cw, r.provider_id, r.model_id, r.mode);
          updated++;
        } else {
          stillNull++;
        }
      }
    });
    tx();
    return { updated, still_null: stillNull, total: rows.length };
  }

  // ─── Catalog ETag ─────────────────────────────────────────────

  /**
   * ETag from the last live model-catalog refresh, stored under
   * `provider_configs.extra.catalog_etag`. The Codex `/models` endpoint
   * returns an ETag that we can replay via `If-None-Match` to short-circuit
   * with a 304 when nothing changed.
   */
  getProviderCatalogEtag(providerId: string): string | null {
    const cfg = this.getProvider(providerId);
    if (!cfg) return null;
    const value = cfg.extra?.catalog_etag;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  setProviderCatalogEtag(providerId: string, etag: string | null): void {
    const cfg = this.getProvider(providerId);
    if (!cfg) return;
    const nextExtra = { ...cfg.extra };
    if (etag === null || etag === '') delete nextExtra.catalog_etag;
    else nextExtra.catalog_etag = etag;
    this.db
      .prepare('UPDATE provider_configs SET extra = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nextExtra), new Date().toISOString(), providerId);
  }

  // ─── Subagent Provider/Model ─────────────────────────────────

  getSubagentTarget(providerId: string): { providerId: string; modelId: string | null } | null {
    const cfg = this.getProvider(providerId);
    if (!cfg) return null;
    const targetProvider = cfg.extra?.subagent_provider_id;
    const provider = typeof targetProvider === 'string' && targetProvider.length > 0
      ? targetProvider
      : providerId;
    const model = this.getSubagentModel(providerId);
    if (provider === providerId && !model) return null;
    return { providerId: provider, modelId: model };
  }

  getSubagentModel(providerId: string): string | null {
    const cfg = this.getProvider(providerId);
    if (!cfg) return null;
    const value = cfg.extra?.subagent_model;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  setSubagentModel(providerId: string, modelId: string | null): void {
    const current = this.getSubagentTarget(providerId);
    this.setSubagentTarget(providerId, current?.providerId ?? providerId, modelId);
  }

  setSubagentTarget(providerId: string, targetProviderId: string | null, modelId: string | null): void {
    const cfg = this.getProvider(providerId);
    if (!cfg) return;
    const nextExtra = { ...cfg.extra };
    if (!targetProviderId || targetProviderId === providerId) delete nextExtra.subagent_provider_id;
    else nextExtra.subagent_provider_id = targetProviderId;
    if (modelId === null || modelId === '') delete nextExtra.subagent_model;
    else nextExtra.subagent_model = modelId;
    this.db
      .prepare('UPDATE provider_configs SET extra = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nextExtra), new Date().toISOString(), providerId);
  }

  // ─── OAuth ────────────────────────────────────────────────────

  getOAuth(providerId: string): OAuthTokenRow | null {
    const row = this.db
      .prepare('SELECT * FROM oauth_tokens WHERE provider_id = ?')
      .get(providerId) as OAuthTokenRaw | undefined;
    return row ? hydrateOAuth(row) : null;
  }

  setOAuth(input: {
    provider_id: string;
    access_token: string;
    refresh_token?: string | null;
    expires_at?: number | null;
    scope?: string | null;
    extra?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (provider_id, access_token, refresh_token, expires_at, scope, extra, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(provider_id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           extra = excluded.extra,
           updated_at = excluded.updated_at`
      )
      .run(
        input.provider_id,
        input.access_token,
        input.refresh_token ?? null,
        input.expires_at ?? null,
        input.scope ?? null,
        JSON.stringify(input.extra ?? {})
      );
  }

  deleteOAuth(providerId: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE provider_id = ?').run(providerId);
  }

  // ─── Embeddings ───────────────────────────────────────────────

  listEmbeddingConfigs(): EmbeddingConfigRow[] {
    const rows = this.db
      .prepare('SELECT * FROM embedding_configs ORDER BY name')
      .all() as EmbeddingConfigRaw[];
    return rows.map(hydrateEmbedding);
  }

  getDefaultEmbedding(): EmbeddingConfigRow | null {
    const row = this.db
      .prepare('SELECT * FROM embedding_configs WHERE is_default = 1 AND enabled = 1 LIMIT 1')
      .get() as EmbeddingConfigRaw | undefined;
    return row ? hydrateEmbedding(row) : null;
  }

  upsertEmbeddingConfig(input: {
    id: string;
    kind: EmbeddingKind;
    name: string;
    enabled?: boolean;
    is_default?: boolean;
    config?: Record<string, unknown>;
  }): EmbeddingConfigRow {
    this.db
      .prepare(
        `INSERT INTO embedding_configs (id, kind, name, enabled, is_default, config, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           enabled = excluded.enabled,
           is_default = excluded.is_default,
           config = excluded.config,
           updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.kind,
        input.name,
        (input.enabled ?? false) ? 1 : 0,
        (input.is_default ?? false) ? 1 : 0,
        JSON.stringify(input.config ?? {})
      );

    if (input.is_default) {
      this.db
        .prepare('UPDATE embedding_configs SET is_default = 0 WHERE id != ? AND is_default = 1')
        .run(input.id);
    }

    return this.listEmbeddingConfigs().find((c) => c.id === input.id)!;
  }

  // ─── Vector Stores ────────────────────────────────────────────

  listVectorStoreConfigs(): VectorStoreConfigRow[] {
    const rows = this.db
      .prepare('SELECT * FROM vector_store_configs ORDER BY name')
      .all() as VectorStoreConfigRaw[];
    return rows.map(hydrateVectorStore);
  }

  getDefaultVectorStore(): VectorStoreConfigRow | null {
    const row = this.db
      .prepare('SELECT * FROM vector_store_configs WHERE is_default = 1 AND enabled = 1 LIMIT 1')
      .get() as VectorStoreConfigRaw | undefined;
    return row ? hydrateVectorStore(row) : null;
  }

  upsertVectorStoreConfig(input: {
    id: string;
    kind: VectorStoreKind;
    name: string;
    enabled?: boolean;
    is_default?: boolean;
    config?: Record<string, unknown>;
  }): VectorStoreConfigRow {
    this.db
      .prepare(
        `INSERT INTO vector_store_configs (id, kind, name, enabled, is_default, config, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           enabled = excluded.enabled,
           is_default = excluded.is_default,
           config = excluded.config,
           updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.kind,
        input.name,
        (input.enabled ?? false) ? 1 : 0,
        (input.is_default ?? false) ? 1 : 0,
        JSON.stringify(input.config ?? {})
      );

    if (input.is_default) {
      this.db
        .prepare('UPDATE vector_store_configs SET is_default = 0 WHERE id != ? AND is_default = 1')
        .run(input.id);
    }

    return this.listVectorStoreConfigs().find((c) => c.id === input.id)!;
  }

  // ─── Disabled Tools (Global) ───────────────────────────────────

  /** All globally disabled tool names. */
  listGlobalDisabledTools(): string[] {
    const rows = this.db
      .prepare('SELECT tool_name FROM disabled_tools_global ORDER BY tool_name')
      .all() as { tool_name: string }[];
    return rows.map((r) => r.tool_name);
  }

  /** Toggle a tool's global disabled state. */
  setGlobalToolDisabled(
    toolName: string,
    disabled: boolean,
    meta?: { tier: string; source: string },
  ): void {
    if (disabled) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO disabled_tools_global (tool_name, tier, source)
           VALUES (?, ?, ?)`,
        )
        .run(toolName, meta?.tier ?? 'bootstrap', meta?.source ?? 'native');
    } else {
      this.db.prepare('DELETE FROM disabled_tools_global WHERE tool_name = ?').run(toolName);
    }
  }

  /** Batch toggle global disabled tools. */
  bulkSetGlobalDisabled(
    tools: Array<{ tool_name: string; disabled: boolean; tier?: string; source?: string }>,
  ): void {
    const tx = this.db.transaction(() => {
      for (const t of tools) {
        this.setGlobalToolDisabled(t.tool_name, t.disabled, {
          tier: t.tier ?? 'bootstrap',
          source: t.source ?? 'native',
        });
      }
    });
    tx();
  }

  // ─── Bootstrap ────────────────────────────────────────────────

  /**
   * Ensure the 5 built-in providers (Anthropic, OpenAI, DeepSeek, ZAI, Gemini)
   * exist as rows so they're visible in the admin UI even before the user
   * sets any API key. Idempotent per-id: only inserts rows that don't exist,
   * never overwrites an existing row (which could contain user edits).
   *
   * Providers without a matching *_API_KEY env var are inserted as `enabled=0`
   * and `api_key=null`, so the user sees them listed but has to fill in a key
   * before they can be used. Providers with an env key are inserted enabled,
   * with the key pre-populated — preserving the .env → DB transition.
   *
   * Promotes the first keyed provider as `is_default=true` only when no
   * default exists yet in the whole table.
   */
  seedFromEnvIfEmpty(): void {
    const env = process.env;

    // Load the provider registry lazily so this file has no compile-time
    // dependency on providers/ (avoids import cycles). The registry drives
    // which shapes are built-in and which env vars seed them.
    //
    // Each definition has envVars[]. If ANY of its env vars is set, the
    // instance is seeded enabled with the api_key pre-populated. Otherwise
    // the row is inserted disabled so the admin UI can surface it.
    //
    // The instance id matches the shape kind for built-ins (row id = 'anthropic',
    // kind = 'anthropic'), preserving backwards compatibility with existing
    // callers that use -p anthropic.
    type SeedBuiltin = {
      id: string;
      name: string;
      kind: string;
      base_url?: string;
      envKey?: string;
      extra?: Record<string, unknown>;
    };

    // Registry is imported statically at the top of the file. The CJS
    // `require('./registry.js')` that used to live here broke under tsx dev
    // because createRequire doesn't apply tsx's `.js → .ts` resolution that
    // the ESM loader does, so the import crashed at runtime even though
    // the compiled dist worked. Static import sidesteps that and there is
    // no real cycle: registry.ts only imports from ./definitions and ./types,
    // none of which touch ProviderStore.
    const builtins: SeedBuiltin[] = listProviderDefinitions()
      .filter((def) => def.envVars.length > 0)  // only api-key shapes auto-seed
      .map((def) => {
        const envKey = def.envVars.map((v) => env[v]).find(Boolean);
        const extra: Record<string, unknown> = {};
        if (def.capabilities?.zaiCodingMode) extra.zai_has_coding_mode = true;
        return {
          id: def.kind,
          name: def.displayName,
          kind: def.kind,
          base_url: def.defaultBaseURL,
          envKey,
          extra,
        };
      });

    const existingDefault = this.db
      .prepare('SELECT id FROM provider_configs WHERE is_default = 1 LIMIT 1')
      .get() as { id: string } | undefined;
    let defaultAssigned = !!existingDefault;

    for (const b of builtins) {
      if (this.getProvider(b.id)) continue; // preserve user edits
      const hasKey = !!b.envKey;
      const shouldBeDefault = hasKey && !defaultAssigned;
      if (shouldBeDefault) defaultAssigned = true;
      this.upsertProvider({
        id: b.id,
        name: b.name,
        kind: b.kind,
        base_url: b.base_url ?? null,
        api_key: b.envKey ?? null,
        enabled: hasKey,
        use_for_agent: true,
        use_for_coder: true,
        is_default: shouldBeDefault,
        extra: b.extra ?? {},
      });
    }

    // Seed Cloudflare embedding config if worker URL is present in env.
    if (env.MCP_INDEX_WORKER_URL) {
      this.upsertEmbeddingConfig({
        id: 'cloudflare',
        kind: 'cloudflare',
        name: 'Cloudflare Vectorize',
        enabled: true,
        is_default: true,
        config: {
          workerUrl: env.MCP_INDEX_WORKER_URL,
          workerToken: env.MCP_INDEX_WORKER_TOKEN ?? '',
          model: env.MCP_INDEX_EMBEDDINGS_MODEL ?? '@cf/baai/bge-base-en-v1.5',
          dimensions: 768,
        },
      });

      // Mirror the embedding config into vector_store_configs so a fresh
      // install with only legacy .env has a default vector backend visible
      // in the admin UI. Idempotent — upsert won't clobber user edits since
      // it keys on id.
      if (this.listVectorStoreConfigs().length === 0) {
        this.upsertVectorStoreConfig({
          id: 'cloudflare',
          kind: 'cloudflare',
          name: 'Cloudflare Vectorize',
          enabled: true,
          is_default: true,
          config: {
            workerUrl: env.MCP_INDEX_WORKER_URL,
            workerToken: env.MCP_INDEX_WORKER_TOKEN ?? '',
          },
        });
      }
    }

    // Seed Qdrant if QDRANT_URL is set in env.
    if (env.QDRANT_URL && !this.listVectorStoreConfigs().some((c) => c.id === 'qdrant')) {
      const hasOther = this.listVectorStoreConfigs().some((c) => c.is_default);
      this.upsertVectorStoreConfig({
        id: 'qdrant',
        kind: 'qdrant',
        name: 'Qdrant',
        enabled: true,
        is_default: !hasOther,
        config: {
          url: env.QDRANT_URL,
          collection: env.QDRANT_COLLECTION ?? 'mcp_code_index',
          apiKey: env.QDRANT_API_KEY ?? '',
        },
      });
    }

    // Seed Pinecone if PINECONE_HOST + PINECONE_API_KEY are set.
    if (
      env.PINECONE_HOST &&
      env.PINECONE_API_KEY &&
      !this.listVectorStoreConfigs().some((c) => c.id === 'pinecone')
    ) {
      const hasOther = this.listVectorStoreConfigs().some((c) => c.is_default);
      this.upsertVectorStoreConfig({
        id: 'pinecone',
        kind: 'pinecone',
        name: 'Pinecone',
        enabled: true,
        is_default: !hasOther,
        config: {
          host: env.PINECONE_HOST,
          apiKey: env.PINECONE_API_KEY,
          namespace: env.PINECONE_NAMESPACE ?? '',
        },
      });
    }

    // Seed Bedrock OpenSearch if OPENSEARCH_ENDPOINT is set. Uses
    // AWS_REGION + AWS credentials from the same env the Bedrock
    // embedding provider reads, so one set of creds powers both.
    if (
      env.OPENSEARCH_ENDPOINT &&
      env.AWS_REGION &&
      !this.listVectorStoreConfigs().some((c) => c.id === 'bedrock-opensearch')
    ) {
      const hasOther = this.listVectorStoreConfigs().some((c) => c.is_default);
      this.upsertVectorStoreConfig({
        id: 'bedrock-opensearch',
        kind: 'bedrock-opensearch',
        name: 'Bedrock + OpenSearch',
        enabled: true,
        is_default: !hasOther,
        config: {
          endpoint: env.OPENSEARCH_ENDPOINT,
          region: env.AWS_REGION,
          indexName: env.OPENSEARCH_INDEX ?? 'mcp-code-index',
          serviceName: (env.OPENSEARCH_SERVICE as 'es' | 'aoss' | undefined) ?? 'aoss',
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          sessionToken: env.AWS_SESSION_TOKEN,
        },
      });
    }
  }
}
