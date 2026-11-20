import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { getGlobalIndexTools } from '../ports/index-tools-port.js';
import { buildNativeIndexTools } from './native-index-tools.js';
import type { InternalToolBinding } from './internal-tool-adapter.js';

/** The index tools of one run, per project binding. */
export interface RunIndexTools {
  /** False when this process registered no index tools port. */
  readonly available: boolean;
  forProject(binding: InternalToolBinding): CoderTool[];
}

/**
 * Index tools for one runCoder call. Every host process registers a port
 * (coder and Company workers, the live bench); without one the run has no
 * mcp__* index tools — including the CORE mcp__grep_code and mcp__search —
 * so it warns on every run instead of failing silently.
 */
export function runIndexTools(db: CodeIndexDB): RunIndexTools {
  const port = getGlobalIndexTools();
  if (!port) {
    console.warn('[coder] index tools: no in-process index tools port is registered in this process; '
      + 'mcp__* index tools (grep_code, search, read_file, …) are unavailable for this run');
    return { available: false, forProject: () => [] };
  }
  return { available: true, forProject: (binding) => buildNativeIndexTools({ port, db, binding }) };
}
