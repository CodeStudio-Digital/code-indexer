import { expect, it, vi } from 'vitest';
import { McpToolBridge } from '../mcp-bridge.js';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { createMutationFenceAuthority } from '../../core/mutation-fence.js';
import type { ToolContext } from '../../core/tool.js';
import { nativeCoderWorkspaceAccess } from '../../../../../apps/http-api/workers/native-coder-catalog.js';

async function fixture() {
  const invoke = vi.fn(async () => 'job #19'); const bridge = new McpToolBridge({ deferConnection: true });
  const tool = (await bridge.listTools({ projectName: 'owned' })).find(t => t.name === 'mcp__index_project')!;
  const registry = new ToolRegistry(); registry.register(tool);
  const context = { cwd: process.cwd(), ports: { projectIndex: { invoke } }, currentToolUseId: 'index-1', toolCallLedger: new ToolCallLedger(),
    mutationFence: createMutationFenceAuthority({ mode: 'enforce', authorizedRoot: process.cwd(), assertLease() {},
      snapshot: () => ({ environmentId: 'index:test', environmentVersion: 1, workspaceLeaseId: 'index:lease', workspaceLeaseVersion: 1,
        workspaceFencingEpoch: 1, ownerAgentRunId: '11111111-1111-4111-8111-111111111111' }) }),
  } as unknown as ToolContext;
  return { tool, invoke, bridge, registry, context };
}
it('binds indexing to an owned sequential administrative resource', async () => {
  const f = await fixture();
  expect(nativeCoderWorkspaceAccess([f.tool])).toBe('exclusive_write');
  for (const change of [{ parallelSafe: true }, { mutates: false }, { effectBoundary: undefined }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...f.tool, ...change }])).toThrow('owned project mutation');
  }
  expect((await f.registry.invoke(f.tool.name, { project_path: process.cwd() }, f.context)).content).toBe('job #19');
  expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'index-1', binding: expect.objectContaining({
    canonicalResources: [{ kind: 'application', appId: f.tool.name, operations: ['index/reconcile'] }],
  }) }));
  await f.bridge.close();
});
it('rejects absent owners and invalid input without opening a server', async () => {
  const f = await fixture();
  expect((await f.tool.handler({ project_path: '' }, f.context)).isError).toBe(true);
  f.context.ports = {};
  expect((await f.tool.handler({ project_path: process.cwd() }, f.context)).isError).toBe(true);
  expect(f.invoke).not.toHaveBeenCalled(); await f.bridge.close();
});
it('keeps a lost ACK uncertain and prevents another indexing mutation', async () => {
  const f = await fixture(); f.invoke.mockRejectedValueOnce(new Error('ACK lost'));
  expect(await f.registry.invoke(f.tool.name, { project_path: process.cwd() }, f.context)).toMatchObject({ effectOutcome: 'unknown' });
  f.context.currentToolUseId = 'index-2';
  await f.registry.invoke(f.tool.name, { project_path: process.cwd() }, f.context);
  expect(f.invoke).toHaveBeenCalledOnce(); await f.bridge.close();
});
