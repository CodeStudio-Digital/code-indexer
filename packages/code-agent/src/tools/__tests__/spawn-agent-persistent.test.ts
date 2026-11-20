/**
 * `kind:'persistent'` only means something in a Company master session, where
 * it delegates to `spawn_subordinate_agent`. Everywhere else the field is not
 * advertised, and a persisted call that still carries it runs as an ordinary
 * ephemeral agent with the parent's real tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionId } from '@mcp/session-storage';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';

vi.mock('@mcp/code-agent/tools/implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/code-agent/tools/implement-subagent.js')>();
  return { ...actual, runSubagent: vi.fn(), runParallelAgents: vi.fn() };
});

const { buildSpawnAgentTool } = await import('@mcp/code-agent/tools/spawn-agent.js');
const { runSubagent } = await import('@mcp/code-agent/tools/implement-subagent.js');
const runSingle = runSubagent as unknown as ReturnType<typeof vi.fn>;

const readTool: CoderTool = {
  name: 'read_file',
  source: 'native',
  description: 'Read a file.',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ content: '' }),
};

function properties(tool: CoderTool): Record<string, unknown> {
  return (tool.parameters as { properties: Record<string, unknown> }).properties;
}

function build(registry: ToolRegistry) {
  return buildSpawnAgentTool(
    { provider: { name: 'openai', model: 'gpt-test' }, parentTools: [readTool] } as never,
    registry,
  );
}

beforeEach(() => {
  runSingle.mockReset();
  runSingle.mockResolvedValue({
    reason: 'completed',
    finalText: 'done',
    usage: { input_tokens: 1, output_tokens: 1 },
    sandboxViolations: [],
    collected: { memos: [], snapshots: [], boardPosts: [] },
  });
});

describe('spawn_agent kind:persistent', () => {
  it('does not advertise kind outside a Company master session', () => {
    expect(properties(build(new ToolRegistry()))).not.toHaveProperty('kind');
  });

  it('advertises kind inside a Company master session', () => {
    const registry = new ToolRegistry();
    registry.register({ ...readTool, name: 'spawn_subordinate_agent' });
    expect(properties(build(registry))).toHaveProperty('kind');
  });

  it('runs a persisted persistent call outside Company with the parent tools', async () => {
    const ctx = { cwd: 'D:/MCP', runner: { sessionId: newSessionId(), agentLoopV2: false, emit: vi.fn() } } as unknown as ToolContext;

    const result = await build(new ToolRegistry()).handler({ agents: [{ task: 'Look around' }], kind: 'persistent' }, ctx);

    expect(result.isError).not.toBe(true);
    expect(runSingle).toHaveBeenCalledTimes(1);
    expect(runSingle.mock.calls[0]?.[0]).toMatchObject({ tools: [readTool] });
  });
});
