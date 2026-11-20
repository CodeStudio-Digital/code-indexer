import { expect, it, vi } from 'vitest';
import { internalToolDefinition } from '../internal-tool-adapter.js';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { createMutationFenceAuthority } from '../../core/mutation-fence.js';
import type { ToolContext } from '../../core/tool.js';

async function fixture() {
  const callTool = vi.fn(); const invoke = vi.fn(async () => '# Export'); const assertMutation = vi.fn();
  const tool = internalToolDefinition({ name: 'export_docs', inputSchema: { type: 'object', properties: {} } },
    { projectName: 'bound' }, 'test', { prepare: async () => callTool });
  const fence: any = { mode: 'enforce', assertMutation, resourceBinding: { id: 'bound' }, bindInvocation() { return this; } };
  const context = { cwd: process.cwd(), ports: { documentExport: { invoke } }, mutationFence: fence,
    currentToolUseId: 'call', toolCallLedger: new ToolCallLedger() } as unknown as ToolContext;
  return { tool, context, invoke, callTool, assertMutation };
}
it('uses the owned port and sealed tool identity without dispatching to the index tools', async () => {
  const f = await fixture(); const result = await f.tool.handler({ format: 'json' }, f.context);
  expect(result.content).toBe('# Export'); expect(f.callTool).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'call', input: { format: 'json' }, binding: { id: 'bound' } }));
  expect(f.assertMutation).toHaveBeenCalledWith({ kind: 'control', resource: 'mcp__export_docs', operation: 'export/publish' });
});
it('refuses native export without an owner and validates input before dispatch', async () => {
  const f = await fixture();
  expect((await f.tool.handler({ sections: ['constructor'] }, f.context)).isError).toBe(true);
  f.context.ports = {};
  expect((await f.tool.handler({}, f.context)).isError).toBe(true);
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.callTool).not.toHaveBeenCalled();
});
it('lost publication confirmation is sticky across another mutation', async () => {
  const f = await fixture(); const registry = new ToolRegistry(); registry.register(f.tool);
  f.invoke.mockRejectedValueOnce(new Error('ACK lost'));
  expect(await registry.invoke(f.tool.name, {}, f.context)).toMatchObject({ effectOutcome: 'unknown' });
  await registry.invoke(f.tool.name, {}, f.context);
  expect(f.invoke).toHaveBeenCalledOnce(); expect(f.callTool).not.toHaveBeenCalled();
});
it('reaches the owned port through registry entry with a real sealed authority', async () => {
  const f = await fixture(); const registry = new ToolRegistry(); registry.register(f.tool);
  let owned = true;
  f.context.mutationFence = createMutationFenceAuthority({
    mode: 'enforce', authorizedRoot: process.cwd(),
    assertLease: () => { if (!owned) throw new Error('lease lost'); },
    snapshot: () => ({ environmentId: 'export:test', environmentVersion: 1,
      workspaceLeaseId: 'lease:export', workspaceLeaseVersion: 1, workspaceFencingEpoch: 1,
      ownerAgentRunId: '11111111-1111-4111-8111-111111111111' }),
  });
  const result = await registry.invoke(f.tool.name, { format: 'json' }, f.context);
  expect(result.content).toBe('# Export'); expect(result.isError).toBeFalsy();
  expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({
    binding: expect.objectContaining({ canonicalResources: [{ kind: 'application', appId: 'mcp__export_docs', operations: ['export/publish'] }] }),
  }));
  owned = false; f.context.currentToolUseId = 'revoked';
  expect((await registry.invoke(f.tool.name, { format: 'json' }, f.context)).isError).toBe(true);
  expect(f.invoke).toHaveBeenCalledOnce(); expect(f.callTool).not.toHaveBeenCalled();
});
