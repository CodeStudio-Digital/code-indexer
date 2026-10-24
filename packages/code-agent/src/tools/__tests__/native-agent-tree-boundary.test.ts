import { expect, it, vi } from 'vitest';
import { runSubagent, type SubagentParent, type SubagentSpec } from '../implement-subagent.js';
import type { AgentTreePort } from '../../ports/agent-tree-port.js';

const spec: SubagentSpec = { systemPrompt: 'fixture', allowlist: null, initialMessages: [], maxTurns: 1 };
function parent(port?: AgentTreePort): SubagentParent {
  return { provider: { name: 'fixture', model: 'fixture', chat: vi.fn() } as unknown as SubagentParent['provider'], tools: [],
    ctx: { cwd: '/fixture', projectName: 'fixture', runtimeGeneration: 'rust_v1', controlPlaneParentAgentRunId: 'root', ports: { agentTree: port } } };
}
it('rejects a native child before touching the legacy runner or provider when admission is absent', async () => {
  const input = parent();
  await expect(runSubagent(input, spec)).rejects.toThrow('legacy child fallback is forbidden');
  expect(input.provider.chat).not.toHaveBeenCalled();
});
it('rejects a foreign tree and a native executor on a legacy parent', async () => {
  const port: AgentTreePort = { runtimeGeneration: 'rust_v1', ownerAgentRunId: 'other', run: vi.fn() };
  await expect(runSubagent(parent(port), spec)).rejects.toThrow('admitted owner');
  const input = parent(port); input.ctx.runtimeGeneration = 'legacy_ts';
  await expect(runSubagent(input, spec)).rejects.toThrow('legacy parent');
  expect(port.run).not.toHaveBeenCalled();
});
it('routes an admitted child only to its owner and combines parent/child cancellation', async () => {
  const rootAbort = new AbortController(); const childAbort = new AbortController();
  const result = { reason: 'completed' as const, finalText: 'done', usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [] };
  const run = vi.fn<AgentTreePort['run']>(async (_parent, child) => {
    expect(child.signal?.aborted).toBe(false); childAbort.abort(); expect(child.signal?.aborted).toBe(true); return result;
  });
  const input = parent({ runtimeGeneration: 'rust_v1', ownerAgentRunId: 'root', run }); input.ctx.signal = rootAbort.signal;
  expect(await runSubagent(input, { ...spec, signal: childAbort.signal })).toBe(result);
  expect(run).toHaveBeenCalledOnce(); expect(input.provider.chat).not.toHaveBeenCalled();
  rootAbort.abort(); await expect(runSubagent(input, spec)).rejects.toThrow(); expect(run).toHaveBeenCalledOnce();
});
