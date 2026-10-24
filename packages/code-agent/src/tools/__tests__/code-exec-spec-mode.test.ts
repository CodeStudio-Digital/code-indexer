import { expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import { ok, type ToolContext } from '../../core/tool.js';
import { buildCodeExecTool } from '../code-exec.js';

function fixture(approved = false) {
  const registry = new ToolRegistry();
  const write = vi.fn(async () => ok('written'));
  const base = { description: 'fixture', source: 'native' as const,
    parameters: { type: 'object' as const, properties: {} } };
  registry.register({ ...base, name: 'fixture_write', mutates: true, parallelSafe: false, riskLevel: 'write', handler: write });
  registry.register({ ...base, name: 'fixture_read', mutates: false, parallelSafe: true, riskLevel: 'read', handler: async () => ok('read') });
  const runner = { opts: { planMode: false }, specMode: true,
    isSpecApproved: () => approved, isPlanApproved: () => false,
    currentTaskScopeId: () => null, currentTaskScopeFiles: () => null } as unknown as ToolContext['runner'];
  return { tool: buildCodeExecTool(registry), write,
    context: { cwd: process.cwd(), projectName: 'fixture', runner } };
}

it('blocks nested mutations until the specification is approved', async () => {
  const f = fixture();
  const result = await f.tool.handler({ code: 'return await tools.fixture_write({});' }, f.context);
  expect(result.isError).toBe(true); expect(result.content).toContain('spec mode');
  expect(f.write).not.toHaveBeenCalled();
});

it('keeps nested reads available while a specification awaits approval', async () => {
  const f = fixture();
  const result = await f.tool.handler({ code: 'return await tools.fixture_read({});' }, f.context);
  expect(result.isError).not.toBe(true); expect(result.content).toContain('read');
});

it('allows nested mutation after the specification approval', async () => {
  const f = fixture(true);
  const result = await f.tool.handler({ code: 'return await tools.fixture_write({});' }, f.context);
  expect(result.isError).not.toBe(true); expect(f.write).toHaveBeenCalledOnce();
});
