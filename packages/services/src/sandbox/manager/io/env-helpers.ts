import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { virtualProjectDir } from '@mcp/shared/utils/data-paths.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';

/**
 * Parse a dotenv-style file body into key→value pairs. Minimal
 * implementation — supports `KEY=VALUE`, trims whitespace, strips a
 * single matching pair of `"`/`'` quotes, skips blank/comment lines.
 * Multiline values and variable expansion are explicitly out of scope.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Render a `.env` file body from a flat map — one line per key, values
 * lightly quoted when they contain whitespace or shell metacharacters.
 */
export function renderDotEnv(envs: Record<string, string>): string {
  const safeKey = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const lines: string[] = [
    '# Managed by MCP SandboxService — shared session env.',
    '# Regenerated on every provision + when agents run env_set/env_delete.',
  ];
  for (const [key, value] of Object.entries(envs)) {
    if (!safeKey.test(key)) continue;
    const needsQuote = /[\s"'`$\\]/.test(value) || value === '';
    const escaped = needsQuote
      ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`
      : value;
    lines.push(`${key}=${escaped}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Resolve the host directory bind-mounted onto the sandbox workdir.
 * Default: `<mcpDataDir>/virtual-projects/<sessionId>`
 * (i.e. `~/.mcp-code-indexer/virtual-projects/<sessionId>`). Operators
 * can relocate the base via `MCP_SANDBOX_WORKDIR_HOST_DIR`. Returns
 * `null` when persistence via bind-mount is explicitly disabled
 * (`MCP_SANDBOX_BIND_MOUNT=0`).
 */
export function resolveHostWorkdirMount(sessionId: string): string | null {
  if (process.env.MCP_SANDBOX_BIND_MOUNT === '0') return null;
  return virtualProjectDir(sessionId);
}

/**
 * Resolve shared env vars for a session. Returns an empty record when
 * the store isn't wired or the session id isn't numeric.
 *
 * Pass `serviceId` ('main' = primary container) to ENFORCE per-service
 * scoping (migration 192): vars whose `service_scope` names other
 * services are excluded. Omitting it keeps the legacy session-wide
 * record (scope-agnostic callers like env_validate).
 */
export function resolveSessionEnvs(
  envStore: CompanySessionEnvStore | null,
  sessionId: string,
  serviceId?: string,
): Record<string, string> {
  if (!envStore) return {};
  const numericId = Number(sessionId);
  if (!Number.isFinite(numericId)) return {};
  try {
    return serviceId !== undefined
      ? envStore.asRecordForService(numericId, serviceId)
      : envStore.asRecord(numericId);
  } catch {
    return {};
  }
}

/**
 * Best-effort import of an existing `.env` file in `hostWorkdirMount`
 * into `company_session_envs`. No-ops on missing file/store/numeric id
 * or read failure. Rows written with `source: 'imported'`,
 * `onlyIfAbsent: true` so user-managed values always win.
 */
export function importDotEnvIntoStore(
  envStore: CompanySessionEnvStore | null,
  hostWorkdirMount: string,
  sessionId: string,
): void {
  if (!envStore) return;
  const numericId = Number(sessionId);
  if (!Number.isFinite(numericId)) return;
  const envPath = join(hostWorkdirMount, '.env');
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, 'utf8');
    const pairs = parseDotEnv(content);
    for (const [key, value] of Object.entries(pairs)) {
      envStore.upsert(numericId, key, value, false, {
        source: 'imported',
        onlyIfAbsent: true,
      });
    }
  } catch (e) {
    console.warn(
      `[sandbox-manager] import .env for session ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
