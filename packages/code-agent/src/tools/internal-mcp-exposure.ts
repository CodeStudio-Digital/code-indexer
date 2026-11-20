import type { CoderTool } from '../core/tool.js';
import type { ToolRegistry } from '../core/registry.js';
import { NATIVE_TWIN_OF } from '../core/tool-name-suggest.js';
import type { DocSearchBackend } from './doc-search-types.js';

/**
 * Which internal MCP tools the agent's own bridges register: the primary
 * project's single bridge, the Company master's prefixed bridges and the
 * prefixed bridges of a global session's secondary projects. The MCP server
 * and the generated catalog are untouched, so external MCP clients keep every
 * tool.
 */

// Starting or cancelling an agent run opens or stops a whole other session.
// Both are write risk, `auto` permission mode does not pause write, and no
// prompt, skill or contract routes an internal agent to them. The read verbs
// (list_agents, list_agent_runs, get_agent_run, get_agent_result) stay.
const AGENT_RUN_CONTROL: ReadonlySet<string> = new Set(['start_agent_run', 'cancel_agent_run']);

/**
 * Doc twins also need the host doc backend to expose the verb their native
 * tool uses; without it the MCP twin is the working route.
 */
const DOC_TWIN_READY: Record<string, (backend: DocSearchBackend) => boolean> = {
  mcp__rag_search_docs: () => true,
  mcp__rag_read_doc: backend => !!backend.readChunk && !!backend.readSection,
  mcp__rag_doc_outline: backend => !!backend.outline,
};

/** The bridge lists every server tool as `mcp__<name>`. */
const serverName = (name: string): string => name.replace(/^mcp__/, '');

function isAgentRunControl(tool: Pick<CoderTool, 'name'>): boolean {
  return AGENT_RUN_CONTROL.has(serverName(tool.name));
}

/**
 * A primary-bridge tool that only duplicates an available native tool
 * (`mcp__read_file`/`mcp__list_directory`, and the `mcp__rag_*` doc readers
 * over the same corpus and project scoping). Prefixed names never match.
 */
export function isRedundantPrimaryTwin(
  tool: Pick<CoderTool, 'name'>,
  nativeAvailable: (name: string) => boolean,
  docBackend: DocSearchBackend | null,
): boolean {
  const native = Object.hasOwn(NATIVE_TWIN_OF, tool.name) ? NATIVE_TWIN_OF[tool.name] : undefined;
  if (!native || !nativeAvailable(native)) return false;
  const ready = DOC_TWIN_READY[tool.name];
  return !ready || (!!docBackend && ready(docBackend));
}

/** Tools the primary project's bridge registers (twins are pruned later). */
export function primaryBridgeTools<T extends Pick<CoderTool, 'name'>>(tools: readonly T[]): T[] {
  return tools.filter(tool => !isAgentRunControl(tool));
}

/**
 * Drop the primary twins whose native tool survived every registry filter and
 * is not disabled. Run AFTER the custom-agent allowlist, the research preset
 * filter and the disabled-tool lists are known: a native removed or disabled
 * there keeps its twin, so the session never loses the capability.
 */
export function pruneRedundantPrimaryTwins(
  registry: Pick<ToolRegistry, 'get' | 'filterInPlace'>,
  disabled: { has(name: string): boolean },
  docBackend: DocSearchBackend | null,
): void {
  const available = new Set(Object.values(NATIVE_TWIN_OF).filter(name => !!registry.get(name) && !disabled.has(name)));
  registry.filterInPlace(tool => !isRedundantPrimaryTwin(tool, name => available.has(name), docBackend));
}

/** Tools a prefixed bridge registers, renamed `mcp__<slug>__<name>`. */
export function prefixedBridgeTools<T extends Pick<CoderTool, 'name'>>(tools: readonly T[], slug: string): T[] {
  return tools
    .filter(tool => !isAgentRunControl(tool))
    .map(tool => ({ ...tool, name: `mcp__${slug}__${serverName(tool.name)}` }));
}
