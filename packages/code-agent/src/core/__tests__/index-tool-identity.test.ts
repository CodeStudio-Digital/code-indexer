/**
 * The index tools (mcp__*) are `source: 'native'` with providerId
 * 'code-indexer'. Everything they used to get from `source === 'mcp'` is now
 * an explicit rule, and each is pinned here against the same tool as it was
 * before (source 'mcp', kind 'mcp_internal'): timeout, Ultra isolation, the
 * operational telemetry label, the labels the model and project hooks see,
 * the permission gate and the uncertain-outcome rule.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CoderTool, ToolContext } from '../tool.js';
import type { ChatProvider } from '../../providers/adapter.js';
import { ToolRegistry } from '../registry.js';
import { buildTools } from '../runner/assembly/tools.js';
import { operationalToolEvents } from '../invocation-evidence.js';
import { resolveToolTimeoutMs, NORMAL_TIMEOUT_MS, SLOW_TIMEOUT_MS } from '../tool-timeouts.js';
import { classifyForGate } from '../permission-gate.js';
import { needsOutcomeRecoveryApproval } from '../uncertain-tool-outcome.js';
import { INDEX_TOOLS_PROVIDER_ID, isIndexTool, publishedToolSource } from '../index-tool-identity.js';
import { isolatedChildTool } from '../../runtime/ultra-workspace.js';
import { buildNativeIndexTools, NATIVE_INDEX_PROVENANCE_REF } from '../../tools/native-index-tools.js';
import { buildFindToolsTool } from '../../tools/find-tools.js';
import { fsTools } from '../../tools/fs.js';
import type { IndexToolsPort } from '../../ports/index-tools-port.js';

const entry = (name: string, description: string) =>
  ({ name, description, inputSchema: { type: 'object', properties: { project_name: { type: 'string' }, query: { type: 'string' } } } });
const port: IndexToolsPort = {
  catalog: () => [entry('search', 'Hybrid code search over the index.'), entry('read_file', 'Read a project file.'),
    entry('get_repo_map', 'Ranked map of the project files.'), entry('save_memory', 'Save a durable project memory.')],
  invoke: async name => ({ content: [{ type: 'text', text: `${name} ok` }] }),
};
const index = new Map(buildNativeIndexTools({ port, db: {} as CodeIndexDB, binding: { projectName: 'p', projectRoot: tmpdir() } })
  .map(tool => [tool.name, tool]));
const tool = (name: string) => index.get(name)!;
/** The same definition as the MCP route produced it (before E7b). */
const asBefore = (t: CoderTool): CoderTool => ({ ...t, source: 'mcp', capabilityProvenance: { ...t.capabilityProvenance!, kind: 'mcp_internal' } });
/** The same tool without the index identity, to show the explicit rule is what keeps the behaviour. */
const plainNative = (t: CoderTool): CoderTool => ({ ...t, capabilityProvenance: undefined });
const READS = ['mcp__search', 'mcp__read_file', 'mcp__get_repo_map'];
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe('index tools are native with the code-indexer identity', () => {
  it('declare source native and the native kind, keeping providerId and provenanceRef', () => {
    for (const t of index.values()) {
      expect(t.source, t.name).toBe('native');
      expect(t.capabilityProvenance, t.name).toEqual({ kind: 'native', providerId: INDEX_TOOLS_PROVIDER_ID, provenanceRef: NATIVE_INDEX_PROVENANCE_REF });
      expect(isIndexTool(t), t.name).toBe(true);
    }
    expect(fsTools.some(isIndexTool)).toBe(false);
  });

  it('keep the slow timeout they had as MCP tools, by explicit rule', () => {
    for (const name of [...READS, 'mcp__save_memory']) {
      expect(resolveToolTimeoutMs(tool(name)), name).toBe(SLOW_TIMEOUT_MS);
      expect(resolveToolTimeoutMs(asBefore(tool(name))), name).toBe(SLOW_TIMEOUT_MS);
      expect(resolveToolTimeoutMs(plainNative(tool(name))), name).toBe(NORMAL_TIMEOUT_MS);
    }
  });

  it('stay out of isolated Ultra children (bound to the main project root), as before', () => {
    for (const name of [...READS, 'mcp__save_memory']) {
      expect(isolatedChildTool(tool(name)), name).toBe(false);
      expect(isolatedChildTool(asBefore(tool(name))), name).toBe(false);
    }
    expect(isolatedChildTool(plainNative(tool('mcp__search')))).toBe(true);
    expect(isolatedChildTool(fsTools.find(t => t.name === 'read_file')!)).toBe(true);
  });

  it('keep the mcp label in the operational tool event; plain native tools stay native', async () => {
    const registry = new ToolRegistry();
    registry.registerAll([tool('mcp__search'), plainNative({ ...tool('mcp__read_file'), name: 'plain_read' })]);
    const ctx = { cwd: tmpdir(), projectName: 'p' } as ToolContext;
    await registry.invoke('mcp__search', { query: 'x' }, ctx);
    await registry.invoke('plain_read', {}, ctx);
    expect(operationalToolEvents().slice(-2).map(event => event.source)).toEqual(['mcp', 'native']);
  });

  it('show the model the same source=mcp in find_tools', async () => {
    const registry = new ToolRegistry();
    registry.registerAll([...index.values()]);
    const res = await buildFindToolsTool(registry).handler({ query: 'hybrid code search' }, { cwd: tmpdir(), projectName: 'p' } as ToolContext);
    expect(res.content).toMatch(/- mcp__search \(tier=[a-z]+, source=mcp\)/);
    expect(publishedToolSource(tool('mcp__search'))).toBe(publishedToolSource(asBefore(tool('mcp__search'))));
  });

  it('reach a project tool-filter hook with source mcp, so a hook written before still selects them', () => {
    const root = mkdtempSync(join(tmpdir(), 'index-hook-')); roots.push(root);
    mkdirSync(join(root, '.mcp-indexer', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.mcp-indexer', 'hooks', 'tool-filter.js'),
      "module.exports = (c) => c.tools.filter(t => t.source === 'mcp' || t.name === 'read_file').map(t => t.name);");
    const registry = new ToolRegistry();
    registry.registerAll([...fsTools, ...index.values()]);
    const names = buildTools({ registry, activeTiers: new Set(['bootstrap', 'navigate']),
      provider: { name: 'openai-chatgpt', model: 'gpt-6.1-sol' } as ChatProvider,
      toolContext: { cwd: root, projectName: 'p' } }).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['mcp__search', 'read_file']));
    expect(names).not.toContain('write_file');
  });

  it('get the same permission class and uncertain-outcome decision as before', () => {
    const recovery = { toolUseIds: ['earlier-call'] } as unknown as ToolContext['outcomeRecovery'];
    for (const name of [...READS, 'mcp__save_memory']) {
      const now = tool(name), before = asBefore(now);
      expect(classifyForGate(now, name, {}), name).toBe(classifyForGate(before, name, {}));
      expect(needsOutcomeRecoveryApproval(recovery, now, {}), name).toBe(needsOutcomeRecoveryApproval(recovery, before, {}));
    }
    expect(classifyForGate(tool('mcp__search'), 'mcp__search', {})).toBe('allow');
    expect(classifyForGate(tool('mcp__save_memory'), 'mcp__save_memory', {})).toBe('write');
    expect(needsOutcomeRecoveryApproval(recovery, tool('mcp__search'), {})).toBe(false);
    expect(needsOutcomeRecoveryApproval(recovery, tool('mcp__save_memory'), {})).toBe(true);
  });
});
