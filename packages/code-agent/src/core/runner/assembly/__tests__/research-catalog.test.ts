/**
 * The research agent's defining tools (web_search, web_fetch) are required
 * pins of that agent, so the stable catalog publishes them directly. They used
 * to be seeded as runtime pins, which the stable catalog never read.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../registry.js';
import type { CoderTool, ToolContext } from '../../../tool.js';
import type { ChatProvider } from '../../../../providers/adapter.js';
import { buildTools } from '../tools.js';
import { isResearchToolAllowed } from '../../../../tools/browser/policy.js';

const tool = (name: string): CoderTool => ({ name, source: 'native', description: `${name}.`,
  parameters: { type: 'object', properties: {} }, handler: async () => ({ content: name }) });

function researchCatalog(requiredPinnedTools?: ReadonlySet<string>): string[] {
  const registry = new ToolRegistry();
  registry.registerAll(['code_exec', 'find_tools', 'read_file', 'list_directory', 'glob', 'mcp__grep_code', 'mcp__search',
    'get_tool_output', 'ask_user', 'web_search', 'web_fetch', 'edit_file', 'exec_command', 'write_stdin',
    ...Array.from({ length: 60 }, (_, i) => `cold_${i}`)].map(tool));
  registry.filterInPlace(isResearchToolAllowed);
  return buildTools({ registry, activeTiers: new Set(['bootstrap']), requiredPinnedTools,
    provider: { name: 'openai-chatgpt', model: 'gpt-6.1-sol' } as ChatProvider,
    toolContext: { cwd: tmpdir(), projectName: 'research', runner: { agentId: 'research' } } as ToolContext,
  }).tools.map(t => t.name);
}

describe('research agent catalog', () => {
  it('publishes web_search and web_fetch only as required pins', () => {
    const without = researchCatalog();
    expect(without).not.toContain('web_search');
    expect(without).not.toContain('web_fetch');
    const pinned = researchCatalog(new Set(['web_search', 'web_fetch']));
    expect(pinned).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    expect(pinned.filter(n => !without.includes(n)).sort()).toEqual(['web_fetch', 'web_search']);
  });

  it('runCoder makes them required pins of the research agent', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../../index.ts', import.meta.url)), 'utf8');
    expect(src).toContain("...(effectiveAgentId === 'research' ? ['web_search', 'web_fetch'] : []),");
    const seed = src.indexOf("...(effectiveAgentId === 'research' ? ['web_search', 'web_fetch'] : []),");
    const configured = src.lastIndexOf('const configuredInitialPins = new Set([', seed);
    expect(configured).toBeGreaterThan(0);
    expect(seed - configured).toBeLessThan(300);
    expect(src).toContain('requiredPinnedTools: configuredInitialPins.size > 0');
  });
});
