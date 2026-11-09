import { describe, expect, it, vi } from 'vitest';
import { allTools } from '../tools/index.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { INTERNAL_MCP_ACCESS, internalMcpContract } from '@mcp/code-agent/tools/internal-mcp-contract.js';
import { McpToolBridge } from '@mcp/code-agent/tools/mcp-bridge.js';

async function bridgeTool(name: string, callTool = vi.fn(async () => { throw new Error('ACK lost'); })) {
  const client = { listTools: async () => ({ tools: [{ name,
    annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} },
  }] }), callTool };
  const bridge = new McpToolBridge();
  (bridge as unknown as { client: typeof client }).client = client;
  return { tool: (await bridge.listTools({ projectName: 'fixture' }))[0]!, callTool };
}

describe('internal MCP effect contracts', () => {
  it('preserves uncertainty reported by the owner even when the MCP transport completed', async () => {
    const call = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Owner lost confirmation' }], isError: true, _meta: { effectOutcome: 'unknown' } });
    const { tool } = await bridgeTool('index_project', call);
    const registry = new ToolRegistry(); registry.register(tool);
    const ctx = { cwd: process.cwd(), toolCallLedger: new ToolCallLedger() } as ToolContext;
    expect(await registry.invoke(tool.name, {}, ctx)).toMatchObject({ effectOutcome: 'unknown', error: { retryable: false } });
    await registry.invoke(tool.name, {}, ctx); expect(call).toHaveBeenCalledOnce();
  });
  it('polls an agent again after its status changes instead of replaying a cached result', async () => {
    const { tool, callTool } = await bridgeTool('get_agent_run');
    const read = vi.fn().mockResolvedValueOnce({ status: 'running' }).mockResolvedValue({ status: 'completed' });
    const registry = new ToolRegistry(); registry.register(tool);
    const ctx = { cwd: process.cwd(), projectName: 'fixture', agentReads: { read }, toolCallLedger: new ToolCallLedger() } as ToolContext;
    expect((await registry.invoke(tool.name, { run_id: 'fixture' }, ctx)).content).toContain('running');
    expect((await registry.invoke(tool.name, { run_id: 'fixture' }, ctx)).content).toContain('completed');
    expect(read).toHaveBeenCalledTimes(2); expect(callTool).not.toHaveBeenCalled();
  });
  it.each(['list_agents', 'list_agent_runs', 'get_agent_run', 'get_agent_result'])('routes %s exclusively to the current application owner', async name => {
    const { tool, callTool } = await bridgeTool(name);
    const read = vi.fn().mockResolvedValue({ owned: true });
    const input = { run_id: 'fixture' };
    const result = await tool.handler(input, { cwd: process.cwd(), projectName: 'fixture', agentReads: { read } } as ToolContext);
    expect(result.structuredData).toEqual({ owned: true });
    expect(result.content).not.toBe('');
    expect(read).toHaveBeenCalledWith(name, input, undefined);
    expect(callTool).not.toHaveBeenCalled();
    expect((await tool.handler(input, { cwd: process.cwd() } as ToolContext)).isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });
  it('covers every first-party definition and agrees with its required access', () => {
    expect(Object.keys(INTERNAL_MCP_ACCESS).sort()).toEqual(allTools.map(tool => tool.name).sort());
    for (const tool of allTools) {
      const contract = internalMcpContract(tool.name);
      expect(contract.riskLevel, tool.name).toBe(tool.scope.slice('mcp:'.length));
      expect(contract.mutates, tool.name).toBe(!tool.annotations.readOnlyHint);
    }
  });

  it.each(['save_memory', 'start_agent_run', 'cancel_agent_run', 'index_project', 'unknown'])
  ('does not allow a retry after %s loses confirmation, even with a remote read hint', async name => {
    const { tool, callTool } = await bridgeTool(name);
    const registry = new ToolRegistry();
    registry.register(tool);
    const ledger = new ToolCallLedger();
    const ctx = { cwd: process.cwd(), toolCallLedger: ledger } as ToolContext;
    expect(await registry.invoke(tool.name, {}, ctx)).toMatchObject({
      effectOutcome: 'unknown', error: { code: 'TOOL_OUTCOME_UNKNOWN', retryable: false },
    });
    expect(ledger.outcomeUnknownTool).toBe(tool.name);
    await registry.invoke(tool.name, {}, ctx);
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('permits recovery from a transport failure for a reviewed read', async () => {
    const { tool } = await bridgeTool('read_file');
    const result = await tool.handler({}, { cwd: process.cwd() } as ToolContext);
    expect(result).toMatchObject({ error: { kind: 'network', retryable: true } });
    expect(result.effectOutcome).toBeUndefined();
  });

  it('classifies a cancelled read without suggesting a retry', async () => {
    const controller = new AbortController();
    const { tool } = await bridgeTool('search', vi.fn(async () => {
      controller.abort(); throw new Error('cancelled');
    }));
    expect(await tool.handler({}, { cwd: process.cwd(), signal: controller.signal } as ToolContext))
      .toMatchObject({ error: { kind: 'cancelled', retryable: false } });
  });

  it('never dispatches or marks an effect uncertain when already cancelled', async () => {
    const { tool, callTool } = await bridgeTool('save_memory');
    const controller = new AbortController(); controller.abort();
    const result = await tool.handler({}, { cwd: process.cwd(), signal: controller.signal } as ToolContext);
    expect(result).toMatchObject({ error: { kind: 'cancelled', retryable: false } });
    expect(result.effectOutcome).toBeUndefined();
    expect(callTool).not.toHaveBeenCalled();
  });
});
