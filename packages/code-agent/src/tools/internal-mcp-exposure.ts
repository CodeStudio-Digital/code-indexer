import type { CoderTool } from '../core/tool.js';
import type { ToolRegistry } from '../core/registry.js';
import { NATIVE_TWIN_OF } from '../core/tool-name-suggest.js';
import type { DocSearchBackend } from './doc-search-types.js';

/**
 * How the index tools reach the agent's registry: the primary project's set
 * as published (its twins of native tools pruned), and the per-project
 * `mcp__<slug>__*` sets of the Company master and of a global session's
 * secondary projects.
 */

/**
 * Doc twins also need the host doc backend to expose the verb their native
 * tool uses; without it the MCP twin is the working route.
 */
const DOC_TWIN_READY: Record<string, (backend: DocSearchBackend) => boolean> = {
  mcp__rag_search_docs: () => true,
  mcp__rag_read_doc: backend => !!backend.readChunk && !!backend.readSection,
  mcp__rag_doc_outline: backend => !!backend.outline,
};

/** Every index tool is registered as `mcp__<name>`. */
const serverName = (name: string): string => name.replace(/^mcp__/, '');

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
  return tools.map(tool => ({ ...tool, name: `mcp__${slug}__${serverName(tool.name)}` }));
}
