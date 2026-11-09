import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { virtualProjectDir } from '@mcp/shared/utils/data-paths.js';
import { scopeIncludesService } from '@mcp/store/env-scope.js';
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
 * Resolve shared env vars for a filesystem session.
 *
 * Pass `serviceId` ('main' = primary container) to ENFORCE per-service
 * scoping (migration 192): vars whose `service_scope` names other
 * services are excluded. Omitting it keeps the legacy session-wide
 * record (scope-agnostic callers like env_validate).
 */
export async function resolveSessionEnvs(
  envStore: CompanySessionEnvStore | null,
  sessionId: string,
  serviceId?: string,
): Promise<Record<string, string>> {
  if (!envStore) return {};
  const rows = await envStore.listAsync(sessionId);
  return Object.fromEntries(rows.filter((r) => serviceId === undefined || scopeIncludesService(r.service_scope, serviceId)).map((r) => [r.key, r.value]));

}
export async function importDotEnvIntoStore(envStore: CompanySessionEnvStore | null, hostWorkdirMount: string, sessionId: string): Promise<void> {
  if (!envStore) return;
  const envPath = join(hostWorkdirMount, '.env');
  if (!existsSync(envPath)) return;
  const pairs = parseDotEnv(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(pairs)) {
    const secret = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|CREDENTIAL|DATABASE_URL|DSN)/i.test(key) || /:\/\/[^/]+:[^/]+@/.test(value);
    await envStore.upsert(sessionId, key, value, secret, { source: 'imported', onlyIfAbsent: true });
  }
}
