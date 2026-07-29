/**
 * Desktop-owned runtime defaults.
 *
 * The development launcher inherits the repository `.env`, while an installed
 * Electron build starts outside the repository and therefore cannot see it.
 * Project databases are durable application state: once a project has been
 * split, feature rows created afterwards (DB connections, API collections,
 * SSH hosts, etc.) live only in that project's SQLite file. Letting the
 * packaged app silently disable routing makes that saved state look lost.
 *
 * Keep the CLI/server defaults unchanged, but make the desktop self-contained.
 * Explicit environment values remain authoritative kill switches.
 */
export function applyDesktopRuntimeEnvDefaults(
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.MCP_PROJECT_DB ??= '1';
  env.MCP_PROJECT_DB_SPLIT ??= '1';
  env.MCP_PROJECT_DB_ROUTE ??= '1';
}
