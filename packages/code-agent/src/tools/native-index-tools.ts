import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { IndexToolsPort } from '../ports/index-tools-port.js';
import {
  internalToolDefinition,
  type InternalToolBinding,
  type InternalToolRoute,
} from './internal-tool-adapter.js';

/**
 * Application/CLI actions the agent never registers. Calling one returns its
 * instruction from RETIRED_TOOL_REPLACEMENTS.
 */
const RETIRED_INDEX_TOOLS: ReadonlySet<string> = new Set(['index_project', 'export_docs']);

/** Telemetry tells native calls apart by this reference. */
export const NATIVE_INDEX_PROVENANCE_REF = 'index-native:code-indexer';

/**
 * The index tools the agent registers: what the port publishes, without the
 * retired application actions. Sorted by name, so the tools array stays
 * stable across sessions (prompt caching).
 */
function nativeEntries(port: IndexToolsPort) {
  return port.catalog()
    .filter(entry => !RETIRED_INDEX_TOOLS.has(entry.name))
    .map(entry => structuredClone(entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The index tools, answered in-process over the run's own database handle:
 * no child process, no stdio.
 */
export function buildNativeIndexTools(options: {
  port: IndexToolsPort;
  db: CodeIndexDB;
  binding: InternalToolBinding;
}): CoderTool[] {
  const route: InternalToolRoute = {
    prepare: async (name, signal) => {
      signal?.throwIfAborted();
      return async (finalArgs, callSignal) => {
        const result = await options.port.invoke(name, finalArgs, { db: options.db, signal: callSignal });
        // A call stopped mid-flight is a lost call: its effect may have completed.
        callSignal?.throwIfAborted();
        return result;
      };
    },
  };
  return nativeEntries(options.port).map(entry =>
    internalToolDefinition(entry, options.binding, NATIVE_INDEX_PROVENANCE_REF, route));
}
