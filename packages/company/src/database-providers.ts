/**
 * Provider registry — single source of truth for what each database
 * provider offers.
 *
 * Adding a new provider (PlanetScale, RDS, CloudSQL) means appending a
 * single entry here; store/routes/tools/UI all read from this map, so
 * no other file changes.
 */
import type { DatabaseProvider, DatabaseWireProtocol, EnvKeyMap } from '@mcp/company/database-types.js';

export interface ProviderField {
  /** Canonical name. What the env key is called when this is the primary DB. */
  name: string;
  /** Mark secret so both the DB row and the dashboard mask the value. */
  secret: boolean;
  placeholder?: string;
  /** Free-text label shown in the UI form (defaults to `name`). */
  label?: string;
}

export interface ProviderMetadataField {
  name: string;
  label?: string;
  placeholder?: string;
}

export interface ProviderSpec {
  /** User-facing label (dashboard modal). */
  label: string;
  /** Which wire protocol driver to use — maps to `pg` or `mysql2`. */
  wireProtocol: DatabaseWireProtocol;
  /** Env keys this provider owns. Order matters for form rendering. */
  fields: ProviderField[];
  /** Optional non-secret metadata fields (Neon branch, Supabase ref). */
  metadata?: ProviderMetadataField[];
  /**
   * Which field holds the connection string used by the driver. Must
   * appear in `fields`. The agent tools resolve the driver URL via
   * env_keys[connectionField] → company_session_envs[envKey].
   */
  connectionField: string;
}

export const PROVIDERS: Record<DatabaseProvider, ProviderSpec> = {
  postgres: {
    label: 'PostgreSQL',
    wireProtocol: 'postgres',
    connectionField: 'DATABASE_URL',
    fields: [
      {
        name: 'DATABASE_URL',
        secret: true,
        placeholder: 'postgres://user:pass@host:5432/db',
      },
    ],
  },
  mysql: {
    label: 'MySQL',
    wireProtocol: 'mysql',
    connectionField: 'DATABASE_URL',
    fields: [
      {
        name: 'DATABASE_URL',
        secret: true,
        placeholder: 'mysql://user:pass@host:3306/db',
      },
    ],
  },
  supabase: {
    label: 'Supabase',
    wireProtocol: 'postgres',
    connectionField: 'DATABASE_URL',
    fields: [
      {
        name: 'SUPABASE_URL',
        secret: false,
        placeholder: 'https://xxxx.supabase.co',
      },
      { name: 'SUPABASE_ANON_KEY', secret: true },
      { name: 'SUPABASE_SERVICE_ROLE_KEY', secret: true },
      {
        name: 'DATABASE_URL',
        secret: true,
        label: 'Postgres pooler URL',
        placeholder: 'postgres://...pooler.supabase.com:6543/postgres',
      },
    ],
    metadata: [{ name: 'project_ref', placeholder: 'xxxx' }],
  },
  neon: {
    label: 'Neon',
    wireProtocol: 'postgres',
    connectionField: 'DATABASE_URL',
    fields: [
      {
        name: 'DATABASE_URL',
        secret: true,
        placeholder: 'postgres://...neon.tech/db?sslmode=require',
      },
    ],
    metadata: [{ name: 'branch', placeholder: 'main' }],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as DatabaseProvider[];

/**
 * Given a provider + label + primary flag, compute the env key each
 * field of the provider should map to. Primary rows use unprefixed
 * names; non-primary rows get a `<BASE>_<LABEL>` suffix derived from
 * the label. Callers can override per-field via `overrides` — the UI
 * exposes this so users can pick custom names (e.g. READ_REPLICA_URL).
 */
export function computeEnvKeys(
  provider: DatabaseProvider,
  label: string,
  isPrimary: boolean,
  overrides: EnvKeyMap = {},
): EnvKeyMap {
  const spec = PROVIDERS[provider];
  const suffix = labelToEnvSuffix(label);
  const out: EnvKeyMap = {};
  for (const field of spec.fields) {
    if (overrides[field.name]) {
      out[field.name] = overrides[field.name];
      continue;
    }
    out[field.name] = isPrimary ? field.name : `${field.name}_${suffix}`;
  }
  return out;
}

/** LABEL → LABEL_UPPER_UNDERSCORE, stripping anything outside [A-Z0-9_]. */
export function labelToEnvSuffix(label: string): string {
  const upper = label.toUpperCase();
  const cleaned = upper.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'DB';
}

/** True when `name` is a known provider ID. */
export function isKnownProvider(name: string): name is DatabaseProvider {
  return name in PROVIDERS;
}
