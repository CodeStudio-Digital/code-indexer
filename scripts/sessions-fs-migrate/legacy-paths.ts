import { join, resolve } from 'node:path';

/**
 * Source-only compatibility for pre-cutover sandbox archives. The new runtime
 * never imports this module and never honors MCP_SANDBOX_ARCHIVE_DIR.
 */
export function legacySandboxArchiveDir(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.MCP_SANDBOX_ARCHIVE_DIR?.trim();
  return override ? resolve(override) : join(resolve(dataDir), 'sandboxes');
}
