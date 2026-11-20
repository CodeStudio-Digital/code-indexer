import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../../registry.js';
import type { CoderTool, ToolContext } from '../../../tool.js';
import { buildTools, fingerprintTools } from '../tools.js';
import { buildFindToolsTool } from '../../../../tools/find-tools.js';

const tool = (name: string): CoderTool => ({ name, source: 'native', description: `Operate ${name}.`,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  handler: async () => ({ content: 'ok' }) });

function fixture() {
  const registry = new ToolRegistry();
  registry.registerAll(['read_file', 'code_exec', 'find_tools', 'get_tool_output', 'exec_command', 'write_stdin', 'list_sessions',
    'apply_patch', 'edit_file', 'view_image', 'ask_user', 'ext_service_lookup', ...Array.from({length: 40}, (_, i) => `cold_${i}`)].map(tool));
  registry.seal();
  return { registry, activeTiers: new Set(['bootstrap']),
    externalToolTiers: new Map([['ext_service_lookup', 'external']]),
    sessionToolCap: 12,
    toolContext: { cwd: tmpdir(), projectName: 'stable-catalog' } as ToolContext,
    provider: { name: 'mock', model: 'mock-model' } as Parameters<typeof buildTools>[0]['provider'] };
}

it('keeps the public contract stable across discoveries, with persistent execution and recovery available', async () => {
  const args = fixture();
  const first = buildTools(args);
  // A discovery is a find_tools call; it publishes nothing new (no runtime pins).
  await buildFindToolsTool(args.registry, args.externalToolTiers).handler({ query: 'ext_service_lookup' }, args.toolContext);
  const later = buildTools(args);
  expect(fingerprintTools(first.tools)).toBe(fingerprintTools(later.tools));
  expect(first.tools.map(t => t.name)).toEqual(expect.arrayContaining(['apply_patch','exec_command','write_stdin','get_tool_output','view_image','ask_user']));
  expect(first.tools.some(t => t.name === 'list_sessions')).toBe(false);
  expect(first.authorizedTools.some(t => t.name === 'list_sessions')).toBe(true);
  expect(first.tools.some(t => t.name === 'ext_service_lookup')).toBe(false);
  expect(first.authorizedTools.some(t => t.name === 'ext_service_lookup')).toBe(true);
});

it('returns the complete hidden input contract without requesting promotion', async () => {
  const args = fixture();
  const promoteTool = vi.fn();
  const result = await buildFindToolsTool(args.registry, args.externalToolTiers).handler({ query: 'ext_service_lookup', limit: 1 }, {
    ...args.toolContext, runner: { stableToolCatalog: true, visibleToolNames: new Set(['find_tools']), promoteTool,
      discoveryState: () => ({ authorization: 'requires_dispatch_validation' }) },
  } as never);
  expect(promoteTool).not.toHaveBeenCalled();
  expect(result.content).toContain('invoke inside code_exec');
  expect(result.structuredData).toMatchObject({ activation: null, candidates: [{ name: 'ext_service_lookup', invokeAs: 'code_exec', inputSchema: { required: ['path'] } }] });
});

it('revokes disabled tools from both projection and generic-dispatch authority', () => {
  const args = fixture();
  const result = buildTools({ ...args, sessionDisabledTools: new Set(['exec_command','ext_service_lookup']) });
  expect(result.tools.some(t => t.name === 'exec_command')).toBe(false);
  expect(result.authorizedTools.some(t => t.name === 'ext_service_lookup')).toBe(false);
});

it('honors a verified provider limit instead of silently publishing too many required tools', () => {
  const args = fixture();
  expect(() => buildTools({ ...args, provider: { ...args.provider, toolLimits: { maxCount: 2, source: 'test' } } })).toThrow('verified provider limit');
});
