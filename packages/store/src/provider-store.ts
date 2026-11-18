/**
 * ProviderStore — persists the admin-configurable LLM providers, their API
 * keys, live/hardcoded model lists and OAuth tokens.
 *
 * Public API. Bodies live in sub-modules under `./provider/` so this file
 * stays under the 250-LOC ceiling. Schema is owned by migration 006.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

import * as providers from './provider/providers.js';
import * as models from './provider/models.js';
import * as modelPrices from './provider/model-prices.js';
import * as appSettings from './provider/app-settings.js';
import * as catalogEtag from './provider/catalog-etag.js';
import * as subagent from './provider/subagent.js';
import * as oauth from './provider/oauth.js';
import * as globalTools from './provider/global-tools.js';
import { seedFromEnvIfEmpty } from './provider/seed.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

// Re-export public types so consumers of `@mcp/store/provider-store.js`
// keep working (`import type { ProviderConfig, ProviderModel, ... }`).
export type {
  ProviderKind,
  AuthMode,
  ProviderConfig,
  ProviderModel,
  OAuthTokenRow,
  UpsertProviderInput,
  UpsertModelInput,
  ModelPriceRow,
  UpsertModelPriceInput,
} from './provider/types.js';

import type {
  ProviderConfig,
  ProviderModel,
  UpsertProviderInput,
  UpsertModelInput,
  OAuthTokenRow,
  ModelPriceRow,
  UpsertModelPriceInput,
} from './provider/types.js';

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

  close(): void { if (this.ownsConnection) this.db.close(); }

  // ─── Providers ─────────────────────────────────────────────────
  listProviders(filter?: providers.ListProvidersFilter): ProviderConfig[] { return providers.list(this.db, filter); }
  getDefaultProvider(): ProviderConfig | null { return providers.getDefault(this.db); }
  getDefaultProviderAndModel(): { kind: string; model: string | undefined } { return providers.getDefaultAndModel(this.db); }
  getProvider(id: string): ProviderConfig | null { return providers.get(this.db, id); }
  upsertProvider(input: UpsertProviderInput): ProviderConfig { return providers.upsert(this.db, input); }
  deleteProvider(id: string): void { providers.del(this.db, id); }

  // ─── Models ────────────────────────────────────────────────────
  listModels(providerId: string, onlyEnabled = false): ProviderModel[] {
    return this.getProvider(providerId) ? models.list(this.db, providerId, onlyEnabled) : [];
  }
  listAllModels(): ProviderModel[] {
    const available = new Set(this.listProviders().map(provider => provider.id));
    return models.listAll(this.db).filter(model => available.has(model.provider_id));
  }
  replaceModelsFromSource(providerId: string, source: string, modelInputs: UpsertModelInput[]): void { models.replaceFromSource(this.db, providerId, source, modelInputs); }
  updateModel(providerId: string, modelId: string, mode: string, patch: Parameters<typeof models.update>[4]): void { models.update(this.db, providerId, modelId, mode, patch); }
  deleteManualModel(providerId: string, modelId: string, mode: string): number { return models.remove(this.db, providerId, modelId, mode); }
  backfillContextWindowsFromRegistry(lookup: (modelId: string) => number | null): { updated: number; still_null: number; total: number } { return models.backfillContextWindows(this.db, lookup); }

  // ─── Model Prices ──────────────────────────────────────────────
  listAllModelPrices(): ModelPriceRow[] { return modelPrices.listAllPrices(this.db); }
  replaceModelPricesFromSource(source: string, prices: UpsertModelPriceInput[]): { inserted: number; skipped_protected: number } { return modelPrices.replacePricesFromSource(this.db, source, prices); }
  upsertManualModelPrice(input: UpsertModelPriceInput): void { modelPrices.upsertManualPrice(this.db, input); }
  seedHardcodedModelPrices(seed: UpsertModelPriceInput[]): number { return modelPrices.seedHardcodedPricesIfMissing(this.db, seed); }

  // ─── App Settings & General Default & Fallback ─────
  getAppSetting(key: string): string | null { return appSettings.getAppSetting(this.db, key); }
  setAppSetting(key: string, value: string): void { appSettings.setAppSetting(this.db, key, value); }
  getGeneralDefault(): { providerId: string; modelId: string } | null { return appSettings.getGeneralDefault(this.db); }
  setGeneralDefault(providerId: string, modelId: string): void { appSettings.setGeneralDefault(this.db, providerId, modelId); }
  getFallbackChain(providerId: string): Array<{ provider: string; model: string }> { return appSettings.getFallbackChain(this.db, providerId); }
  setFallbackProvider(providerId: string, fallbackProviderId: string | null): void { appSettings.setFallbackProvider(this.db, providerId, fallbackProviderId); }

  // ─── Catalog ETag ──────────────────────────────────────────────
  getProviderCatalogEtag(providerId: string): string | null { return catalogEtag.get(this.db, providerId); }
  setProviderCatalogEtag(providerId: string, etag: string | null): void { catalogEtag.set(this.db, providerId, etag); }

  // ─── Subagent ──────────────────────────────────────────────────
  getSubagentTarget(providerId: string): { providerId: string; modelId: string | null } | null { return subagent.getTarget(this.db, providerId); }
  getSubagentModel(providerId: string): string | null { return subagent.getModel(this.db, providerId); }
  setSubagentModel(providerId: string, modelId: string | null): void { subagent.setModel(this.db, providerId, modelId); }
  setSubagentTarget(providerId: string, targetProviderId: string | null, modelId: string | null): void { subagent.setTarget(this.db, providerId, targetProviderId, modelId); }
  getSubagentProfileTarget(providerId: string, profileId: string): { providerId: string; modelId: string | null } | null { return subagent.getProfileTarget(this.db, providerId, profileId); }
  setSubagentProfileTarget(providerId: string, profileId: string, targetProviderId: string | null, modelId: string | null): void { subagent.setProfileTarget(this.db, providerId, profileId, targetProviderId, modelId); }
  getSubagentEffort(providerId: string): string | null { return subagent.getSubagentEffort(this.db, providerId); }
  setSubagentEffort(providerId: string, effort: string | null): void { subagent.setSubagentEffort(this.db, providerId, effort); }
  getSubagentProfileEffort(providerId: string, profileId: string): string | null { return subagent.getProfileEffort(this.db, providerId, profileId); }
  setSubagentProfileEffort(providerId: string, profileId: string, effort: string | null): void { subagent.setProfileEffort(this.db, providerId, profileId, effort); }
  getSubagentProfileLimits(providerId: string, profileId: string): { maxToolCalls: number | null; timeoutMs: number | null } { return subagent.getProfileLimits(this.db, providerId, profileId); }
  setSubagentProfileLimits(providerId: string, profileId: string, patch: { maxToolCalls?: number | null; timeoutMs?: number | null }): void { subagent.setProfileLimits(this.db, providerId, profileId, patch); }

  // ─── OAuth ─────────────────────────────────────────────────────
  getOAuth(providerId: string): OAuthTokenRow | null { return oauth.get(this.db, providerId); }
  setOAuth(input: oauth.SetOAuthInput): void { oauth.set(this.db, input); }
  deleteOAuth(providerId: string): void { oauth.del(this.db, providerId); }
  saveCopilotConnection(input: UpsertProviderInput, modelInputs: UpsertModelInput[]): void {
    this.db.transaction(() => {
      providers.upsert(this.db, input);
      models.replaceFromSource(this.db, input.id, 'live', modelInputs);
      oauth.del(this.db, input.id);
    })();
  }

  // ─── Global Disabled Tools ─────────────────────────────────────
  listGlobalDisabledTools(): string[] { return globalTools.listDisabled(this.db); }
  setGlobalToolDisabled(toolName: string, disabled: boolean, meta?: { tier: string; source: string }): void { globalTools.setDisabled(this.db, toolName, disabled, meta); }
  bulkSetGlobalDisabled(tools: Array<{ tool_name: string; disabled: boolean; tier?: string; source?: string }>): void { globalTools.bulkSetDisabled(this.db, tools); }

  // ─── Bootstrap ─────────────────────────────────────────────────
  seedFromEnvIfEmpty(): void { seedFromEnvIfEmpty(this.db); }
}
