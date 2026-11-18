import type { Database as DB } from 'better-sqlite3';
import { listProviderSeedDefinitions as listProviderDefinitions } from '@mcp/services/providers/seed-catalog.js';
import * as providers from './providers.js';

/**
 * Ensure the built-in providers exist as rows so they're visible in the admin
 * UI even before the user sets any API key. Idempotent per-id: only inserts
 * rows that don't exist, never overwrites an existing row.
 *
 * Provider credentials are NEVER sourced from the environment: every api-key
 * shape is seeded `enabled=0` and `api_key=null` regardless of any *_API_KEY
 * env var. The provider configuration (admin UI / `provider_configs` row) is
 * the sole credential source — an env token is inert and only the spec stays
 * functional. `unbakeEnvSeededKeys` then strips any key a previous build had
 * already copied from the env, so the change takes effect on an existing DB.
 */
export function seedFromEnvIfEmpty(db: DB): void {
  const env = process.env;

  for (const definition of listProviderDefinitions()) {
    if (providers.get(db, definition.kind)) continue;
    const authMode = definition.credKind === 'aws' ? 'aws_sigv4' : definition.credKind === 'oauth' ? 'oauth' : 'api_key';
    providers.upsert(db, {
      id: definition.kind,
      name: definition.displayName,
      kind: definition.kind,
      base_url: definition.defaultBaseURL ?? null,
      api_key: null,
      auth_mode: authMode,
      enabled: false,
      use_for_agent: authMode === 'api_key',
      use_for_coder: true,
      is_default: false,
    });
  }

  unbakeEnvSeededKeys(db, env);
  // Semantic inference is configured exclusively through semantic_profiles.
  // Legacy embedding/vector/reranker config rows are intentionally ignored.
}

/**
 * Un-bake credentials that an earlier build auto-seeded from the environment.
 *
 * Older seeds copied `process.env.<X>_API_KEY` into `provider_configs.api_key`
 * and enabled the row. Now that env tokens are inert, strip any built-in row
 * (`id === kind`, the auto-seeded instance) whose stored key still equals a
 * current env value: clear the key, disable it, and drop the default flag.
 *
 * Scoped to `id === kind` so a provider the user added manually with their own
 * id is never touched. Idempotent: once cleared, the row no longer matches.
 */
function unbakeEnvSeededKeys(db: DB, env: NodeJS.ProcessEnv): void {
  for (const def of listProviderDefinitions()) {
    if (def.envVars.length === 0) continue;
    const row = providers.get(db, def.kind);
    if (!row || !row.api_key || row.id !== def.kind) continue;
    const envValue = def.envVars.map((v) => env[v]).find(Boolean);
    if (!envValue || row.api_key !== envValue) continue;
    providers.upsert(db, {
      id: row.id,
      name: row.name,
      kind: row.kind,
      base_url: row.base_url,
      api_key: null,
      auth_mode: row.auth_mode,
      enabled: false,
      use_for_agent: row.use_for_agent,
      use_for_coder: row.use_for_coder,
      use_for_general: row.use_for_general,
      is_default: false,
      extra: row.extra,
    });
  }
}
