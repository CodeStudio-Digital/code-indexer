import { expect, it, vi } from 'vitest';
import { internalToolDefinition } from '../internal-tool-adapter.js';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import { createMutationFenceAuthority } from '../../core/mutation-fence.js';
import type { ToolContext } from '../../core/tool.js';
import { parseProjectMemoryInput } from '@mcp/shared/memory-write.js';

const input = { title: ' Bound reads ', content: 'Use a bounded page.', category: 'convention', importance: 0.92, referenced_files: ['src\\index.ts'] };
async function fixture() {
  const callTool = vi.fn(), invoke = vi.fn(async () => ({ created: 1, merged: 0, skipped: 0 }));
  const tool = internalToolDefinition({ name: 'save_memory', inputSchema: { type: 'object', properties: {} } },
    { projectName: 'bound' }, 'test', { prepare: async () => callTool });
  const registry = new ToolRegistry(); registry.register(tool);
  const context = { cwd: process.cwd(), projectName: 'bound', currentToolUseId: 'memory-call', ports: { memoryMutations: { invoke } },
    toolCallLedger: new ToolCallLedger(), mutationFence: createMutationFenceAuthority({ mode: 'enforce',
      authorizedRoot: process.cwd(), assertLease() {}, snapshot: () => ({ environmentId: 'export:test', environmentVersion: 1,
        workspaceLeaseId: 'lease:memory', workspaceLeaseVersion: 1, workspaceFencingEpoch: 1,
        ownerAgentRunId: '11111111-1111-4111-8111-111111111111' }) }),
  } as ToolContext;
  return { registry, context, invoke, callTool, tool };
}
it('preserves metadata through the real registry and binds only project memory', async () => {
  const f = await fixture();
  const args = { ...input, scope: 'user', project_name: 'foreign', projectId: 999 };
  expect((await f.registry.invoke(f.tool.name, args, f.context)).content).toContain('Memory "Bound reads" saved');
  expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'mcp__save_memory', input: args,
    binding: expect.objectContaining({ canonicalResources: [{ kind: 'database', databaseId: 'memory:project', operations: ['save_memory.save'] }] }) }));
  expect(f.callTool).not.toHaveBeenCalled();
  expect(parseProjectMemoryInput(input)).toMatchObject({ title: 'Bound reads', importance: 0.92, referencedFiles: ['src/index.ts'] });
});
it.each([{ title: '' }, { content: 'x'.repeat(64001) }, { category: 'user' }, { importance: NaN }, { importance: 1.1 },
  { referenced_files: [' ../secret'] }, { referenced_files: [' C:\\secret'] }, { referenced_files: ['\\server\\file'] },
  { referenced_files: Array(257).fill('file') }])('rejects malformed memory before publication: %o', async invalid => {
  const f = await fixture();
  expect((await f.registry.invoke(f.tool.name, { ...input, ...invalid }, f.context)).isError).toBe(true);
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.callTool).not.toHaveBeenCalled();
});
it('never falls back to the index tools without an owned port or after a lost receipt', async () => {
  const f = await fixture(); f.context.ports = {};
  expect((await f.registry.invoke(f.tool.name, input, f.context)).isError).toBe(true);
  f.context.ports = { memoryMutations: { invoke: f.invoke } };
  f.invoke.mockRejectedValueOnce(new Error('ACK lost'));
  expect(await f.registry.invoke(f.tool.name, input, f.context)).toMatchObject({ effectOutcome: 'unknown' });
  await f.registry.invoke(f.tool.name, input, f.context);
  expect(f.invoke).toHaveBeenCalledOnce(); expect(f.callTool).not.toHaveBeenCalled();
});
