/**
 * Native index tools: the definitions are the port's catalog without the two
 * application/CLI actions, sorted by name. A run without a registered port has
 * no index tools and warns every time; with one, calls stay in-process (no
 * child).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { JsonSchema, ToolContext } from '../../core/tool.js';
import { ToolRegistry } from '../../core/registry.js';
import { toolReplacement } from '../../core/tool-name-suggest.js';
import { buildNativeIndexTools, NATIVE_INDEX_PROVENANCE_REF } from '../native-index-tools.js';
import { runIndexTools } from '../index-tool-source.js';
import { internalMcpContract } from '../internal-mcp-contract.js';
import { stripInjectedProjectName } from '../internal-tool-schema.js';
import { setGlobalIndexTools, type IndexToolCatalogEntry, type IndexToolsPort } from '../../ports/index-tools-port.js';

const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class { constructor() { spawned.count++; } },
}));

const binding = { projectName: 'native-project', projectRoot: '/tmp/native-project' };
const db = {} as CodeIndexDB;
const schema = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', properties: { project_name: { type: 'string' }, ...properties }, required: ['project_name', ...required] });
/** Shaped like the real port's entries (unsorted here on purpose). */
const CATALOG: IndexToolCatalogEntry[] = [
  { name: 'search', description: 'Hybrid code search.', inputSchema: schema({ query: { type: 'string' } }, ['query']) },
  { name: 'read_file', description: 'Read a file.', inputSchema: schema({ file_path: { type: 'string' } }, ['file_path']) },
  { name: 'grep_code', description: 'Exact search.', inputSchema: schema({ pattern: { type: 'string' } }, ['pattern']) },
];
const NEVER_REGISTERED: IndexToolCatalogEntry[] = ['index_project', 'export_docs']
  .map(name => ({ name, description: `${name} (application only)`, inputSchema: schema({}, []) }));
const RETIRED_AGENT_READS = ['mcp__list_agents', 'mcp__list_agent_runs', 'mcp__get_agent_run', 'mcp__get_agent_result'];
const port = (catalog = CATALOG, invoke = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))) =>
  ({ catalog: () => structuredClone(catalog), invoke }) as unknown as IndexToolsPort & { invoke: typeof invoke };
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

afterEach(() => {
  vi.restoreAllMocks();
  setGlobalIndexTools(null);
});

describe('native index tool definitions', () => {
  it('are the port catalog, sorted, with their text and schema', () => {
    const tools = buildNativeIndexTools({ port: port(), db, binding });
    expect(tools.map(tool => tool.name)).toEqual(['mcp__grep_code', 'mcp__read_file', 'mcp__search']);
    const expected = [...CATALOG].sort(byName);
    expected.forEach((entry, i) => expect(tools[i], entry.name).toMatchObject({
      name: `mcp__${entry.name}`, description: entry.description, source: 'native', ...internalMcpContract(entry.name),
      parameters: stripInjectedProjectName(entry.inputSchema as unknown as JsonSchema),
      capabilityProvenance: { kind: 'native', providerId: 'code-indexer', provenanceRef: NATIVE_INDEX_PROVENANCE_REF },
    }));
  });

  it('keep the published text and schema byte for byte and never touch the port catalog', () => {
    const catalog = structuredClone(CATALOG);
    const before = JSON.stringify(catalog);
    const tools = buildNativeIndexTools({ port: port(catalog), db, binding });
    for (const entry of catalog) {
      const tool = tools.find(t => t.name === `mcp__${entry.name}`)!;
      expect(tool.description).toBe(entry.description);
      expect(JSON.stringify(tool.parameters)).toBe(JSON.stringify(stripInjectedProjectName(entry.inputSchema as unknown as JsonSchema)));
      (tool.parameters as { properties: Record<string, unknown> }).properties.injected = { type: 'string' };
    }
    expect(JSON.stringify(catalog)).toBe(before);
    expect(JSON.stringify(buildNativeIndexTools({ port: port(catalog), db, binding }).map(t => t.parameters)))
      .not.toContain('injected');
  });

  it('never register the application actions, even when a port publishes them', () => {
    const names = buildNativeIndexTools({ port: port([...CATALOG, ...NEVER_REGISTERED]), db, binding }).map(t => t.name);
    expect(names).toEqual(buildNativeIndexTools({ port: port(), db, binding }).map(t => t.name));
  });

  it('answer index_project, export_docs and the retired agent-run reads with the retired-tool instruction', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(buildNativeIndexTools({ port: port(), db, binding }));
    for (const name of ['mcp__index_project', 'mcp__export_docs', ...RETIRED_AGENT_READS]) {
      const res = await registry.invoke(name, {}, { cwd: '/tmp' } as ToolContext);
      expect(res.isError).toBe(true);
      expect(res.content).toBe(toolReplacement(name)!.text);
      expect(res.error).toMatchObject({ code: 'RETIRED_TOOL', kind: 'invalid_input', retryable: false });
    }
  });
});

describe('index tools of one run', () => {
  it('without a registered port: no index tools, and a warning on every run', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let run = 1; run <= 2; run++) {
      const tools = runIndexTools(db);
      expect(tools.available).toBe(false);
      expect(tools.forProject(binding)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(run);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no in-process index tools port is registered'));
  });

  it('with a registered port: definitions from it and calls in-process, without a child process', async () => {
    const native = port();
    setGlobalIndexTools(native);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tools = runIndexTools(db);
    expect(tools.available).toBe(true);
    const listed = tools.forProject(binding);
    expect(listed.map(t => t.name)).toEqual(buildNativeIndexTools({ port: native, db, binding }).map(t => t.name));
    const grep = listed.find(tool => tool.name === 'mcp__grep_code')!;
    const result = await grep.handler({ pattern: 'x' }, { cwd: '/tmp' } as ToolContext);
    expect(result.content).toBe('ok');
    expect(native.invoke).toHaveBeenCalledWith('grep_code', { pattern: 'x', project_name: 'native-project' }, { db, signal: undefined });
    expect(warn).not.toHaveBeenCalled();
    expect(spawned.count).toBe(0);
  });

  it('binds every project the run registers to the same port and database', async () => {
    const native = port();
    setGlobalIndexTools(native);
    const tools = runIndexTools(db);
    const second = tools.forProject({ projectName: 'second-project', projectRoot: '/tmp/second' });
    await second.find(t => t.name === 'mcp__grep_code')!.handler({ pattern: 'y' }, { cwd: '/tmp' } as ToolContext);
    expect(native.invoke).toHaveBeenCalledWith('grep_code', { pattern: 'y', project_name: 'second-project' }, { db, signal: undefined });
  });
});
