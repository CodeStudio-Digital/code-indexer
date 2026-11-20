import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import type { CoderTool } from '../../core/tool.js';
import type { DocSearchBackend } from '../doc-search-types.js';
import { ragSearchDocsTools } from '../rag-search-docs.js';
import { ragReadDocTools } from '../rag-read-doc.js';
import { ragDocOutlineTools } from '../rag-doc-outline.js';
import { isRedundantPrimaryTwin, prefixedBridgeTools } from '../internal-mcp-exposure.js';
import { INTERNAL_MCP_ACCESS } from '../internal-mcp-contract.js';

const TWINS = ['mcp__rag_search_docs', 'mcp__rag_read_doc', 'mcp__rag_doc_outline'];
const fullBackend = { search: async () => ({ results: [] }), readChunk: async () => null,
  readSection: async () => null, outline: async () => null } as unknown as DocSearchBackend;
const tool = (name: string) => ({ name }) as Pick<CoderTool, 'name'>;
function nativeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([...ragSearchDocsTools, ...ragReadDocTools, ...ragDocOutlineTools]);
  return registry;
}
/** A native counts as available when registered (index.ts also checks the disabled lists). */
const available = (registry: ToolRegistry) => (name: string) => !!registry.get(name);
/** Every first-party index tool as `mcp__<name>` (the access map covers each one the server defines). */
const FIRST_PARTY = Object.keys(INTERNAL_MCP_ACCESS);
const bridged = () => FIRST_PARTY.map(name => tool(`mcp__${name}`));
/** The agent-run API's verbs: four reads (retired in E8d) and two control verbs (never registered). */
const AGENT_RUN_VERBS = ['list_agents', 'list_agent_runs', 'get_agent_run', 'get_agent_result', 'start_agent_run', 'cancel_agent_run'];

describe('primary MCP duplicates of native doc tools', () => {
  it('drops the three MCP doc twins when the native tools and their backend verbs exist', () => {
    for (const name of TWINS) expect(isRedundantPrimaryTwin(tool(name), available(nativeRegistry()), fullBackend), name).toBe(true);
  });

  it('keeps a doc twin whose native is disabled', () => {
    for (const name of TWINS) expect(isRedundantPrimaryTwin(tool(name), () => false, fullBackend), name).toBe(false);
  });

  it('keeps the MCP twins when the host doc backend is not wired', () => {
    for (const name of TWINS) expect(isRedundantPrimaryTwin(tool(name), available(nativeRegistry()), null), name).toBe(false);
  });

  it('keeps a twin whose native counterpart lacks the backend verb it needs', () => {
    const searchOnly = { search: async () => ({ results: [] }) } as unknown as DocSearchBackend;
    expect(isRedundantPrimaryTwin(tool('mcp__rag_search_docs'), available(nativeRegistry()), searchOnly)).toBe(true);
    expect(isRedundantPrimaryTwin(tool('mcp__rag_read_doc'), available(nativeRegistry()), searchOnly)).toBe(false);
    expect(isRedundantPrimaryTwin(tool('mcp__rag_doc_outline'), available(nativeRegistry()), searchOnly)).toBe(false);
  });

  it('keeps twins without a registered native tool, and never touches other or prefixed tools', () => {
    for (const name of TWINS) expect(isRedundantPrimaryTwin(tool(name), available(new ToolRegistry()), fullBackend), name).toBe(false);
    for (const name of ['mcp__search_memory', 'mcp__save_memory', 'mcp__read_file', 'mcp__proj__rag_search_docs']) {
      expect(isRedundantPrimaryTwin(tool(name), available(nativeRegistry()), fullBackend), name).toBe(false);
    }
  });
});

describe('index tools as the internal bridges register them', () => {
  it('the first-party index tools carry no agent-run verb', () => {
    for (const name of AGENT_RUN_VERBS) expect(FIRST_PARTY, name).not.toContain(name);
  });

  it('a prefixed bridge (Company master, global secondary) prefixes every tool and drops none', () => {
    const names = prefixedBridgeTools(bridged(), 'proj').map(t => t.name);
    expect(names).toEqual(FIRST_PARTY.map(name => `mcp__proj__${name}`));
    expect(names).toContain('mcp__proj__rag_search_docs'); // no native twin per secondary project
  });

  it('every index tool listing in index.ts is registered, primary as published and secondary prefixed', () => {
    const src = readFileSync(fileURLToPath(new URL('../../index.ts', import.meta.url)), 'utf8');
    const listings = src.match(/\.forProject\(\{/g)?.length ?? 0;
    const primary = src.match(/\bregistry\.registerAll\(mcpTools\)/g)?.length ?? 0;
    const prefixed = src.match(/\bprefixedBridgeTools\(mcpTools\b/g)?.length ?? 0;
    expect(listings).toBe(3);
    expect([primary, prefixed]).toEqual([1, 2]);
  });

  it('index.ts prunes primary twins once, after the disabled lists and every registry filter', () => {
    const src = readFileSync(fileURLToPath(new URL('../../index.ts', import.meta.url)), 'utf8');
    const prune = src.indexOf('pruneRedundantPrimaryTwins(registry');
    expect(src.split('pruneRedundantPrimaryTwins(registry').length - 1).toBe(1);
    for (const earlier of ['const sessionDisabledTools = await', 'registry.filterInPlace(isResearchToolAllowed)',
      'registry.filterInPlace((tool) => exactAllowedToolNames.has(tool.name))']) {
      expect(src.indexOf(earlier), earlier).toBeGreaterThan(0);
      expect(src.indexOf(earlier), earlier).toBeLessThan(prune);
    }
    // Before the child snapshot every subagent (and request_review) draws from.
    expect(src.indexOf('childToolSnapshot = childDisabled.size > 0')).toBeGreaterThan(prune);
  });
});
