import { expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { operationalToolEvents } from '../invocation-evidence.js';

it('preserves partial evidence across nested dispatch and records no sensitive contents', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'read_fixture', source: 'native', description: '', mutates: false, riskLevel: 'read',
    parameters: { type: 'object', properties: {} }, handler: async () => ({ content: 'secret-result',
      structuredData: { token: 'secret-structured' }, sourceTruncations: [{ technique: 'row-cap', unit: 'rows', inputSize: 3, inputSizeExact: false, outputSize: 2, recoverable: false }] }) });
  let parentId = '';
  registry.register({ name: 'nested_fixture', source: 'native', description: '', mutates: false, riskLevel: 'read',
    parameters: { type: 'object', properties: {} }, handler: async (_args, ctx) => {
      parentId = ctx.invocation!.invocationId;
      return registry.invoke('read_fixture', { password: 'secret-input' }, ctx);
    } });
  const result = await registry.invoke('nested_fixture', {}, { cwd: '/secret-path', projectName: 'fixture' });
  expect(result.evidence).toMatchObject({ version: 2, invocationId: parentId, effect: 'none', completeness: 'partial' });
  expect(result.structuredData).toEqual({ token: 'secret-structured' });
  const events = operationalToolEvents().slice(-2);
  expect(events[0].parentInvocationId).toBe(parentId);
  expect(events[1].invocationId).toBe(parentId);
  expect(JSON.stringify(events)).not.toMatch(/secret|password|token|fixture/);
});
