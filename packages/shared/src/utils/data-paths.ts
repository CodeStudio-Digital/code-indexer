/**
 * Per-subsystem subdirectories under the canonical MCP data dir
 * (`mcpDataDir()` → `~/.codestudio-local`, overridable via `MCP_DATA_DIR`).
 *
 * Single source of truth so features stop hardcoding
 * `join(process.cwd(), 'data', …)` — which scattered runtime state into
 * the project root instead of the user's home. Operator overrides for
 * the bind-mounted dirs are honored here too, so the HTTP routes and the
 * sandbox manager always agree on the same path.
 */
import { join, resolve } from 'node:path';
import { asSessionId } from '@mcp/agent-runtime-contracts/ids.js';
import { mcpDataDir } from './config.js';

/**
 * Base dir for per-session virtual-project workdirs. Honors
 * `MCP_SANDBOX_WORKDIR_HOST_DIR` (operators relocate the bind-mount root).
 */
export function virtualProjectsBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MCP_SANDBOX_WORKDIR_HOST_DIR?.trim();
  return override ? resolve(override) : join(mcpDataDir(env), 'virtual-projects');
}

/** Workdir for a single filesystem-backed session. */
export function virtualProjectDir(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(virtualProjectsBaseDir(env), asSessionId(sessionId));
}

/**
 * Base dir for global (multi-project) session workspaces — one subdir per
 * global session holding directory junctions/symlinks to each linked project.
 */
export function globalWorkspacesBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'global-workspaces');
}

/** The virtual union dir for a single global workspace id. */
export function globalWorkspaceDir(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(globalWorkspacesBaseDir(env), asSessionId(sessionId));
}

/** Managed LSP server installs — `<dataDir>/lsp-servers/<id>@<version>/`. */
export function lspServersBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'lsp-servers');
}

/** Base dir for on-demand database drivers (`<base>/<engine>@<version>/node_modules/...`). */
export function dbDriversBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpDataDir(env), 'db-drivers');
}
