import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import {
  PermissionGate,
  approvalAskId,
  type ToolPermissionMode,
} from '@mcp/code-agent/core/permission-gate.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

/**
 * Runner-level integration of the PermissionGate (the mechanism that replaced
 * the legacy per-agent "confirmBeforeIrreversible" confirm-gate). Unit coverage
 * of the gate's mode×risk matrix and pause protocol lives in
 * `packages/code-agent/src/core/__tests__/permission-gate.test.ts`; these tests
 * assert the WIRING — that a gated tool call actually pauses the runner via
 * `tool_approval_request`, and that the approve/deny verdict routed back through
 * `provideUserInput` decides whether the tool runs.
 */

/** Emits ONE tool_use on the first turn, then plain text. */
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

const listDirTool: CoderTool = {
  name: 'mcp__list_directory',
  description: 'stub list directory (read-only)',
  source: 'mcp',
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ content: 'a.ts\nb.ts' }),
};

function makeRunner(opts: {
  provider: ChatProvider;
  tool: CoderTool;
  mode: ToolPermissionMode;
  /** Verdict routed back for each approval request (JSON-serialized). */
  onApproval?: (payload: { toolName: string; toolUseId: string }) => unknown;
}) {
  const registry = new ToolRegistry();
  registry.register(opts.tool);
  const toolContext = { cwd: '/tmp', projectName: 'test' } as ToolContext;
  const runner = new CoderRunner({
    provider: opts.provider,
    registry,
    systemPrompt: 'sys',
    toolContext,
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  });
  runner.setToolPermissionMode(opts.mode);
  // Wire the gate exactly like the host (index.ts): live mode read, events +
  // wait/resume routed through the runner's own interaction slots.
  toolContext.permissionGate = new PermissionGate({
    getMode: () => runner.getToolPermissionMode(),
    emit: (event, payload) => {
      runner.emit(event, payload as never);
    },
    waitForUserInput: (askId) => runner.waitForUserInput(askId),
  });
  if (opts.onApproval) {
    runner.on('tool_approval_request', (payload) => {
      const p = payload as unknown as { toolName: string; toolUseId: string };
      const verdict = opts.onApproval!({ toolName: p.toolName, toolUseId: p.toolUseId });
      runner.provideUserInput(JSON.stringify(verdict), approvalAskId(p.toolUseId));
    });
  }
  return runner;
}

describe('runner ↔ PermissionGate integration', () => {
  it('pauses an admin-class tool for approval and refuses it on deny', async () => {
    const asked: string[] = [];
    const runner = makeRunner({
      provider: new SingleToolUseProvider('git_commit', { message: 'wip' }),
      tool: gitCommitTool,
      mode: 'ask',
      onApproval: (p) => {
        asked.push(p.toolName);
        return { approved: false, note: 'not now' };
      },
    });
    const results: Array<{ name: string; isError?: boolean; content: string }> = [];
    runner.on('tool_call_result', (_id, name, result) =>
      results.push({ name, isError: result.isError, content: result.content }),
    );
    await runner.run();

    expect(asked).toEqual(['git_commit']);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content.startsWith('[user-denied')).toBe(true);
    expect(results[0].content).toContain('not now');
  });

  it('lets an admin-class tool run when the user approves', async () => {
    const runner = makeRunner({
      provider: new SingleToolUseProvider('git_commit', { message: 'wip' }),
      tool: gitCommitTool,
      mode: 'ask',
      onApproval: () => ({ approved: true }),
    });
    const results: Array<{ isError?: boolean; content: string }> = [];
    runner.on('tool_call_result', (_id, _name, result) =>
      results.push({ isError: result.isError, content: result.content }),
    );
    await runner.run();

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBeFalsy();
    expect(results[0].content).toBe('committed abc123');
  });

  it('does NOT gate a read-only tool, even in the strictest ("ask") mode', async () => {
    const asked: string[] = [];
    const runner = makeRunner({
      provider: new SingleToolUseProvider('mcp__list_directory', {}),
      tool: listDirTool,
      mode: 'ask',
      onApproval: (p) => {
        asked.push(p.toolName);
        return { approved: true };
      },
    });
    const results: Array<{ isError?: boolean; content: string }> = [];
    runner.on('tool_call_result', (_id, _name, result) =>
      results.push({ isError: result.isError, content: result.content }),
    );
    await runner.run();

    expect(asked).toEqual([]); // never paused for approval
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBeFalsy();
    expect(results[0].content).toBe('a.ts\nb.ts');
  });
});
