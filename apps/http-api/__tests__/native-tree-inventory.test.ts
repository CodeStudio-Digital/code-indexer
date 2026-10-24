import { expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { listAgents } from '@mcp/code-agent/tools/list-agents.js';
import { waitAgents } from '@mcp/code-agent/tools/wait-agents.js';
import { NativeTreeInventory } from '../workers/native-tree-inventory.js';
import { nativeCoderWorkspaceAccess } from '../workers/native-coder-catalog.js';

it('shows the whole owned tree with caller-relative identity and detached snapshots', () => {
  const inventory = new NativeTreeInventory('root');
  inventory.admit({ agentRunId: 'child', parentAgentRunId: 'root', role: 'subagent', provider: 'configured', model: 'chosen' });
  inventory.admit({ agentRunId: 'grandchild', parentAgentRunId: 'child', role: 'verify', provider: 'configured', model: 'chosen' });
  inventory.update('child', { status: 'waiting', is_alive: true });
  const first = inventory.list('child');
  expect(first.map(m => [m.path, m.is_self])).toEqual([
    ['/root', false], ['/root/agent-child', true], ['/root/agent-child/agent-grandchild', false],
  ]);
  first[1].status = 'failed'; expect(inventory.list('root')[1].status).toBe('waiting');
  inventory.update('child', { status: 'completed', is_alive: false });
  expect(inventory.list('root')[1]).toMatchObject({ status: 'completed', is_alive: false, model: 'chosen' });
  expect(() => inventory.list('foreign')).toThrow('Foreign');
  expect(() => inventory.admit({ agentRunId: 'child', parentAgentRunId: 'root', role: 'coder', provider: 'p', model: 'm' })).toThrow('admission');
  expect(() => inventory.admit({ agentRunId: '../foreign', parentAgentRunId: 'root', role: 'coder', provider: 'p', model: 'm' })).toThrow('admission');
});

it('caps retained tree identities without evicting completed admissions', () => {
  const inventory = new NativeTreeInventory('root');
  for (let i = 0; i < 255; i++) inventory.admit({ agentRunId: `child-${i}`, parentAgentRunId: 'root', role: 'coder', provider: 'p', model: 'm' });
  expect(() => inventory.admit({ agentRunId: 'overflow', parentAgentRunId: 'root', role: 'coder', provider: 'p', model: 'm' })).toThrow('admission');
  expect(inventory.list('root')).toHaveLength(256);
});

it('queries native ownership without reading a legacy company orchestrator', async () => {
  const inventory = new NativeTreeInventory('root'), controller = new AbortController();
  inventory.admit({ agentRunId: 'child', parentAgentRunId: 'root', role: 'coder', provider: 'p', model: 'm' });
  inventory.update('child', { status: 'completed', is_alive: false });
  const list = vi.fn(async () => inventory.list('root'));
  const context = { cwd: process.cwd(), runtimeGeneration: 'rust_v1', signal: controller.signal,
    companyContext: { get orchestrator() { throw new Error('Legacy access'); } }, ports: { agentTree: { list } } } as unknown as ToolContext;
  expect((await listAgents.handler({ filter: 'completed' }, context)).content).toContain('/root/agent-child');
  expect((await listAgents.handler({ filter: 'self' }, context)).content).not.toContain('agent-child');
  const json = await listAgents.handler({ format: 'json' }, context);
  expect(json.contentFormat).toBe('json'); expect(JSON.parse(json.content).total).toBe(2);
  expect((await listAgents.handler({}, { ...context, ports: {} })).isError).toBe(true);
  controller.abort(); await expect(listAgents.handler({}, context)).rejects.toThrow(); expect(list).toHaveBeenCalledTimes(3);
});

it('requires a fresh read-only inventory capability', () => {
  expect(nativeCoderWorkspaceAccess([listAgents])).toBe('read_only');
  expect(() => nativeCoderWorkspaceAccess([{ ...listAgents, mutates: true }])).toThrow('contract');
  expect(() => nativeCoderWorkspaceAccess([{ ...listAgents, repeatPolicy: undefined }])).toThrow('contract');
  expect(nativeCoderWorkspaceAccess([waitAgents])).toBe('read_only');
  expect(() => nativeCoderWorkspaceAccess([{ ...waitAgents, parallelSafe: true }])).toThrow('contract');
});

function waitingTree() {
  const inventory = new NativeTreeInventory('root');
  for (const agentRunId of ['one', 'two']) {
    inventory.admit({ agentRunId, parentAgentRunId: 'root', role: 'coder', provider: 'p', model: 'm' });
    inventory.update(agentRunId, { status: 'running', is_alive: true });
  }
  return inventory;
}

it.each(['completed', 'failed', 'interrupted', 'waiting'] as const)('wakes on %s without polling and releases the listener', async status => {
  const inventory = waitingTree();
  const pending = inventory.wait('root', { targets: ['/root/agent-one'], timeoutMs: 1000 });
  expect(inventory.pendingWaitCount).toBe(1);
  inventory.update('one', { status, is_alive: status === 'waiting' });
  expect(await pending).toMatchObject({ kind: status === 'waiting' ? 'attention' : 'all_done', agents: [{ status }] });
  expect(inventory.pendingWaitCount).toBe(0);
});

it('rejects self, ancestor, foreign, queued and cyclic waits without retaining slots', async () => {
  const inventory = waitingTree();
  for (const target of ['one', 'root', 'foreign']) await expect(inventory.wait('one', { targets: [target], timeoutMs: 1000 })).rejects.toThrow();
  inventory.update('two', { status: 'starting' });
  await expect(inventory.wait('one', { targets: ['two'], timeoutMs: 1000 })).rejects.toThrow('queued');
  inventory.update('two', { status: 'running' });
  const controller = new AbortController(), first = inventory.wait('one', { targets: ['two'], timeoutMs: 1000, signal: controller.signal });
  await expect(inventory.wait('two', { targets: ['one'], timeoutMs: 1000 })).rejects.toThrow('cycle');
  controller.abort(new Error('stop wait')); await expect(first).rejects.toThrow('stop wait');
  expect(inventory.pendingWaitCount).toBe(0);
});

it('cleans expired waits and checks all requested agents rather than only the first', async () => {
  const inventory = waitingTree(); inventory.update('one', { status: 'completed', is_alive: false });
  expect(await inventory.wait('root', { targets: ['one', 'two'], timeoutMs: 0 })).toMatchObject({ kind: 'timeout' });
  expect(inventory.pendingWaitCount).toBe(0);
  inventory.update('two', { status: 'completed', is_alive: false });
  expect(await inventory.wait('root', { targets: ['one', 'two', 'one'], timeoutMs: 0 })).toMatchObject({ kind: 'all_done', agents: [{}, {}] });
});

it('routes wait_agents to native ownership and propagates cancellation', async () => {
  const inventory = waitingTree(), controller = new AbortController();
  const wait = vi.fn((input) => inventory.wait('root', input));
  const context = { cwd: process.cwd(), runtimeGeneration: 'rust_v1', signal: controller.signal,
    ports: { agentTree: { wait } } } as unknown as ToolContext;
  expect((await waitAgents.handler({ paths: ['/root/agent-one'], timeout_minutes: 0 }, context)).isError).toBe(true);
  const pending = waitAgents.handler({ agent_run_ids: ['one'] }, context);
  controller.abort(new Error('cancel')); await expect(pending).rejects.toThrow('cancel');
  expect(inventory.pendingWaitCount).toBe(0);
});
