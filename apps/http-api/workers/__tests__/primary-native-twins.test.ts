/**
 * One read name and one list name on the primary project: the primary
 * bridge's `mcp__read_file` / `mcp__list_directory` are dropped while the
 * native `read_file` / `list_directory` survive every filter (custom agent
 * allowlist, research preset) and are not disabled globally or for the
 * session. A disabled native keeps its MCP twin, which the direct catalog
 * then publishes. Prefixed bridges are untouched. The index tools carry the
 * real definitions (text and schema from the index tools port, agent reads
 * from code-agent), with a stub handler; no database is opened.
 */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { createIndexToolsPort } from '@mcp/indexer/agent-tools/port.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { buildTools } from '@mcp/code-agent/core/runner/assembly/tools.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { buildFindToolsTool } from '@mcp/code-agent/tools/find-tools.js';
import { buildCodeExecTool } from '@mcp/code-agent/tools/code-exec.js';
import { EXPLORE_ALLOWLIST, IMPLEMENT_ALLOWLIST } from '@mcp/code-agent/tools/implement-subagent.js';
import { REVIEW_ALLOWLIST } from '@mcp/code-agent/tools/review-subagent.js';
import { RESEARCH_TOOL_NAMES } from '@mcp/code-agent/tools/browser/policy.js';
import { docsTools } from '@mcp/code-agent/tools/index-docs/docs.js';
import { buildNativeIndexTools } from '@mcp/code-agent/tools/native-index-tools.js';
import { prefixedBridgeTools, pruneRedundantPrimaryTwins } from '@mcp/code-agent/tools/internal-mcp-exposure.js';

const port = createIndexToolsPort({ config: {} as IndexerConfig, extraTools: docsTools });
const bridged = (): CoderTool[] => buildNativeIndexTools({ port, db: {} as CodeIndexDB, binding: { projectName: 'p', projectRoot: tmpdir() } })
  .map(tool => ({ ...tool, handler: async () => ({ content: `${tool.name.slice('mcp__'.length)} via index tools` }) }));

/** The registration order index.ts follows: natives, primary index tools, filters, then the twin pass. */
function session(disabled: ReadonlySet<string> = new Set(), keep?: (tool: CoderTool) => boolean): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(fsTools);
  registry.registerAll(bridged());
  if (keep) registry.filterInPlace(keep);
  pruneRedundantPrimaryTwins(registry, disabled, null);
  return registry;
}
const has = (registry: ToolRegistry, name: string) => !!registry.get(name);

describe('primary bridge twins of the native read/list tools', () => {
  it('registers read_file and list_directory without their MCP twins', () => {
    const registry = session();
    expect(has(registry, 'read_file') && has(registry, 'list_directory')).toBe(true);
    expect(has(registry, 'mcp__read_file')).toBe(false);
    expect(has(registry, 'mcp__list_directory')).toBe(false);
    expect(has(registry, 'mcp__grep_code')).toBe(true); // every other index tool stays
  });

  it('find_tools answers "read file" with the native tool only', async () => {
    const registry = session();
    const res = await buildFindToolsTool(registry).handler({ query: 'read file' }, { cwd: tmpdir(), projectName: 'p' } as ToolContext);
    expect(res.content).toContain('read_file');
    expect(res.content).not.toContain('mcp__read_file');
  });

  it.each([
    ['global', 'globalDisabledTools'], ['session', 'sessionDisabledTools'],
  ] as const)('a %s-disabled native keeps its twin, and the direct catalog publishes it', (_scope, key) => {
    const disabled = new Set(['read_file', 'list_directory']);
    const registry = session(disabled);
    expect(has(registry, 'mcp__read_file') && has(registry, 'mcp__list_directory')).toBe(true);
    const names = buildTools({ registry, activeTiers: new Set(['bootstrap', 'navigate']),
      provider: { name: 'openai-chatgpt', model: 'gpt-6.1-sol' } as ChatProvider,
      toolContext: { cwd: tmpdir(), projectName: 'p' }, [key]: disabled }).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['mcp__read_file', 'mcp__list_directory']));
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('list_directory');
  });

  it('a native removed by an earlier filter (custom allowlist) keeps its twin', () => {
    const registry = session(new Set(), tool => tool.name !== 'read_file');
    expect(has(registry, 'mcp__read_file')).toBe(true);
    expect(has(registry, 'mcp__list_directory')).toBe(false);
  });

  it('leaves prefixed bridges (Company master, global secondary) untouched', () => {
    const registry = new ToolRegistry();
    registry.registerAll(fsTools);
    registry.registerAll(prefixedBridgeTools(bridged(), 'proj'));
    pruneRedundantPrimaryTwins(registry, new Set(), null);
    expect(has(registry, 'mcp__proj__read_file') && has(registry, 'mcp__proj__list_directory')).toBe(true);
  });

  it.each([
    ['explore', EXPLORE_ALLOWLIST], ['implement', IMPLEMENT_ALLOWLIST], ['review', REVIEW_ALLOWLIST], ['research', RESEARCH_TOOL_NAMES],
  ] as const)('the %s surface keeps one read and one list tool with or without the natives', (_name, allowed) => {
    for (const [disabled, read, list] of [
      [new Set<string>(), 'read_file', 'list_directory'],
      [new Set(['read_file', 'list_directory']), 'mcp__read_file', 'mcp__list_directory'],
    ] as const) {
      const visible = session(disabled).list().map(t => t.name).filter(n => allowed.has(n) && !disabled.has(n));
      expect(visible).toContain(read);
      expect(visible).toContain(list);
      expect(visible.filter(n => /(^|__)read_file$/.test(n))).toHaveLength(1);
    }
  });

  it('a call to an unregistered twin names the native tool; a registered twin runs', async () => {
    const ctx = { cwd: tmpdir(), projectName: 'p' } as ToolContext;
    const missing = await session().invoke('mcp__read_file', { file_path: 'a.ts' }, ctx);
    expect(missing).toMatchObject({ isError: true, error: { code: 'USE_NATIVE_TOOL' } });
    expect(missing.content).toMatch(/^mcp__read_file is not available in this session\. Use read_file /);
    const fallback = await session(new Set(['read_file'])).invoke('mcp__read_file', { file_path: 'a.ts' }, ctx);
    expect(fallback.content).toBe('read_file via index tools');
  });

  it.each([
    "await mcp__read_file({ file_path: 'a.ts' })",
    "await tools.mcp__list_directory({ path: '.' })",
    "tool_schema('mcp__read_file')",
  ])('inside code_exec, %s names the native tool', async (call) => {
    const res = await buildCodeExecTool(session()).handler({ code: `${call}; return 'unreachable';` },
      { cwd: tmpdir(), projectName: 'p' } as ToolContext);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/mcp__(read_file|list_directory) is not available in this session\. Use (read_file|list_directory) /);
  });
});
