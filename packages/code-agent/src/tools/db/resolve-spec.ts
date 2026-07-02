/**
 * Saved `db_connections` row → live driver config, decrypting secrets
 * just-in-time via the injected decryptor. Faithful port of the dashboard's
 * `resolveSpec` (apps/dashboard/features/db-client/api.ts) minus the renderer
 * concerns (no dbOverride browsing; `readOnly` lives in pool meta, not here).
 *
 * SSH-tunneled connections are REFUSED: the agent process cannot open
 * tunnels — that path belongs to the Databases tab UI.
 *
 * Every tool catch routes through `scrubDbError` so a driver error can never
 * echo a password or DSN back into the transcript.
 */
import type { DbConnectConfig, DbSslConfig } from '@mcp/db-drivers/types.js';
import type { DbConnection } from '@mcp/store/db-client-store-types.js';
import type { DbSecretDecryptor } from './store-binding.js';

export interface ResolvedDbSpec {
  config: DbConnectConfig;
  /** Plaintext secrets to scrub out of error messages (password/DSN/SSL key). */
  secrets: string[];
}

/** Parse the options_json blob (never throws). */
export function parseConnOptions(conn: Pick<DbConnection, 'options_json'>): Record<string, unknown> {
  try {
    return JSON.parse(conn.options_json || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** URL-mode: the encrypted blob IS the whole DSN (password baked in). */
export function isUrlMode(conn: Pick<DbConnection, 'options_json'>): boolean {
  return parseConnOptions(conn).urlMode === true;
}

/** The subset of options passed to the driver (timeout / app name). */
function pickConnectOptions(options: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (typeof options.connectTimeoutMs === 'number') out.connectTimeoutMs = options.connectTimeoutMs;
  if (typeof options.applicationName === 'string' && options.applicationName) {
    out.applicationName = options.applicationName;
  }
  return Object.keys(out).length ? out : undefined;
}

async function resolveSsl(
  conn: DbConnection,
  decrypt: DbSecretDecryptor,
): Promise<DbSslConfig | undefined> {
  if (!conn.ssl_mode || conn.ssl_mode === 'disable') return undefined;
  return {
    mode: conn.ssl_mode,
    ca: conn.enc_ssl_ca ? await decrypt(conn.enc_ssl_ca) : undefined,
    cert: conn.enc_ssl_cert ? await decrypt(conn.enc_ssl_cert) : undefined,
    key: conn.enc_ssl_key ? await decrypt(conn.enc_ssl_key) : undefined,
  };
}

/** True when the row carries any SSH tunnel config (saved host OR inline spec). */
export function usesSshTunnel(
  conn: Pick<DbConnection, 'ssh_tunnel_host_id' | 'ssh_tunnel_json'>,
): boolean {
  if (conn.ssh_tunnel_host_id != null) return true;
  const raw = (conn.ssh_tunnel_json ?? '').trim();
  return raw !== '' && raw !== 'null' && raw !== '{}';
}

/**
 * Build the driver config for a saved connection. Throws (didactic, secret-free)
 * for SSH-tunneled rows; decrypt errors from the injected decryptor propagate.
 */
export async function resolveConnConfig(
  conn: DbConnection,
  decrypt: DbSecretDecryptor,
): Promise<ResolvedDbSpec> {
  if (usesSshTunnel(conn)) {
    throw new Error(
      `Connection '${conn.label}' uses an SSH tunnel — the db_* agent tools cannot open ` +
        'tunnels. Use the Databases tab for this connection, or register a direct one.',
    );
  }
  const options = parseConnOptions(conn);
  const secret = conn.enc_password ? String(await decrypt(conn.enc_password)) : '';
  const ssl = await resolveSsl(conn, decrypt);
  const connectOptions = pickConnectOptions(options);
  const secrets = [secret, ssl?.key ?? ''].filter((s) => s.length > 0);
  if (options.urlMode === true) {
    return {
      config: { engine: conn.engine, ssl, options: connectOptions, connectionString: secret || undefined },
      secrets,
    };
  }
  return {
    config: {
      engine: conn.engine,
      host: conn.host ?? undefined,
      port: conn.port ?? undefined,
      user: conn.username ?? undefined,
      password: secret || undefined,
      database: conn.database_name ?? undefined,
      filePath: conn.file_path ?? undefined,
      ssl,
      options: connectOptions,
    },
    secrets,
  };
}

/** `scheme://user:pass@host` → `scheme://user:***@host` (any residual DSN). */
const URL_CRED_RE = /(\w[\w+.-]*:\/\/[^:/@\s]+):[^@\s]+@/g;

/**
 * Render an error message with every known secret masked. ALL `db_*` tool
 * catches must pass through here — drivers happily echo the failing DSN.
 */
export function scrubDbError(e: unknown, spec?: ResolvedDbSpec | null): string {
  let msg = e instanceof Error ? e.message : String(e);
  for (const s of spec?.secrets ?? []) {
    if (s) msg = msg.split(s).join('***');
  }
  return msg.replace(URL_CRED_RE, '$1:***@');
}
