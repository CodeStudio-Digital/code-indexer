import type { PreflightReport } from '@mcp/api-bus';
import { runPreflight } from '@mcp/services/preflight/index.js';
import type { HandlerDeps } from '../types.js';

/**
 * Run the first-run host checks. The services report is structurally identical
 * to the wire `PreflightReport`, so it's returned verbatim. The disk check uses
 * the data dir derived from the SQLite db path.
 */
export function getPreflight(deps: HandlerDeps): Promise<PreflightReport> {
  return runPreflight({ dbPath: deps.config.dbPath });
}
