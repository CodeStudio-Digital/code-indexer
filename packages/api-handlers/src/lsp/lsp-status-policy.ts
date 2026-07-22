import type { LspManagerStatus } from '@mcp/services/lsp/lsp-server-manager-types.js';

/** Fileless probes identify a family only and may not warm a fallback profile. */
export function shouldWarmLspStatus(file: string | undefined, status: LspManagerStatus): boolean {
  return Boolean(file && status.state === 'idle' && status.server);
}
