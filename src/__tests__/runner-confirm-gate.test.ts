import { describe, it, expect } from 'vitest';
import { CoderRunner } from '../core/coder/core/runner.js';
import { ToolRegistry } from '../core/coder/core/registry.js';
import type { CoderTool } from '../core/coder/core/tool.js';
import type { ChatProvider, ChatRequest } from '../core/coder/providers/adapter.js';
import type { ChatDelta } from '../core/coder/core/messages.js';

/**
 * Provider that emits ONE tool_use call on its first turn, then finishes
 * with plain text. Mirrors the stub used in runner-policy-integration.ts.
 */
class SingleToolUseProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  private call = 0;
  setModel(m: string) {
    this.model = m;
  }
  constructor(
    private readonly toolName: string,
    private readonly input: Record<string, unknown> = {},
  ) {}
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.call++;
    if (this.call === 1) {
      yield {
        type: 'tool_call_end',
        id: 'call-1',
        name: this.toolName,
        input: this.input,
      };
    } else {
      yield { type: 'text_delta', text: 'all done' };
    }
    yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

/**
 * Emits the SAME tool_use twice across the first two turns, then text. Used
 * to verify the retry path: first attempt blocks, second is interpreted as
 * "user confirmed via ask_user" and goes through.
 */
class DoubleToolUseProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  private call = 0;
  setModel(m: string) {
    this.model = m;
  }
  constructor(
    private readonly toolName: string,
    private readonly input: Record<string, unknown> = {},
  ) {}
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.call++;
    if (this.call <= 2) {
      yield {
        type: 'tool_call_end',
        id: `call-${this.call}`,
        name: this.toolName,
        input: this.input,
      };
    } else {
      yield { type: 'text_delta', text: 'done' };
    }
    yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

const gitCommitTool: CoderTool = {
  name: 'git_commit',
  description: 'stub git commit',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'admin',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
  handler: async () => ({ content: 'committed abc123' }),
};

const listSnapshotsTool: CoderTool = {
  name: 'mcp__list_snapshots',
  description: 'stub list snapshots (read-only)',
  source: 'mcp',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ content: 'no snapshots' }),
};

function makeRunner(opts: {
  provider: ChatProvider;
  tool: CoderTool;
  agentId?: 'explore' | 'plan' | 'build' | 'admin';
}) {
  const registry = new ToolRegistry();
  registry.register(opts.tool);
  return new CoderRunner({
    provider: opts.provider,
    registry,
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    agentId: opts.agentId ?? null,
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  });
}

describe('runner confirm-gate (Camada B)', () => {
  it('blocks an irreversible internal tool on the first attempt under admin agent', async () => {
    const runner = makeRunner({
      provider: new SingleToolUseProvider('git_commit', { message: 'wip' }),
      tool: gitCommitTool,
      agentId: 'admin',
    });
    const blocked: Array<{ tool: string; reason: string; detail?: string }> = [];
    runner.on('blocked', (p) =>
      blocked.push({ tool: p.tool, reason: p.reason, detail: p.detail }),
    );
    const results: Array<{ name: string; isError?: boolean; content: string }> = [];
    runner.on('tool_call_result', (_id, name, result) =>
      results.push({ name, isError: result.isError, content: result.content }),
    );
    await runner.run();

    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ tool: 'git_commit', reason: 'admin_required' });
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toMatch(/ask_user/);
    expect(results[0].content).toMatch(/retry the EXACT same/);
  });

  it('passes through on the second attempt (retry interpreted as user-confirmed)', async () => {
    const runner = makeRunner({
      provider: new DoubleToolUseProvider('git_commit', { message: 'wip' }),
      tool: gitCommitTool,
      agentId: 'admin',
    });
    const blocked: Array<{ tool: string }> = [];
    runner.on('blocked', (p) => blocked.push({ tool: p.tool }));
    const results: Array<{ name: string; isError?: boolean; content: string }> = [];
    runner.on('tool_call_result', (_id, name, result) =>
      results.push({ name, isError: result.isError, content: result.content }),
    );
    await runner.run();

    // First call blocks once; second call succeeds.
    expect(blocked).toHaveLength(1);
    expect(results).toHaveLength(2);
    expect(results[0].isError).toBe(true);
    expect(results[1].isError).toBeFalsy();
    expect(results[1].content).toBe('committed abc123');
  });

  it('does NOT gate read-only tools (mcp__list_snapshots) under admin', async () => {
    const runner = makeRunner({
      provider: new SingleToolUseProvider('mcp__list_snapshots', {}),
      tool: listSnapshotsTool,
      agentId: 'admin',
    });
    const blocked: Array<{ tool: string }> = [];
    runner.on('blocked', (p) => blocked.push({ tool: p.tool }));
    const results: Array<{ name: string; isError?: boolean; content: string }> = [];
    runner.on('tool_call_result', (_id, name, result) =>
      results.push({ name, isError: result.isError, content: result.content }),
    );
    await runner.run();

    expect(blocked).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBeFalsy();
    expect(results[0].content).toBe('no snapshots');
  });

  it('does NOT gate destructive tools under build agent (only admin opted in)', async () => {
    const runner = makeRunner({
      provider: new SingleToolUseProvider('git_commit', { message: 'wip' }),
      tool: gitCommitTool,
      agentId: 'build',
    });
    const blocked: Array<{ tool: string; reason: string }> = [];
    runner.on('blocked', (p) => blocked.push({ tool: p.tool, reason: p.reason }));
    const results: Array<{ name: string; isError?: boolean; content: string }> = [];
    runner.on('tool_call_result', (_id, name, result) =>
      results.push({ name, isError: result.isError, content: result.content }),
    );
    await runner.run();

    expect(blocked).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBeFalsy();
    expect(results[0].content).toBe('committed abc123');
  });
});
