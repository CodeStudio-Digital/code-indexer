import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";

/**
 * Provider that emits a tool_use on the FIRST turn and finishes with text
 * on subsequent turns. Without the second-turn exit, the runner would
 * keep looping over the same tool because the stub keeps suggesting it.
 */
class SingleToolUseProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  private call = 0;
  setModel(m: string) { this.model = m; }
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

const recordingTool: CoderTool = {
  name: 'recording_writer',
  description: 'pretend to write a file',
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  scopeAware: true,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  handler: async () => ({ content: 'wrote something' }),
};

function makeRunner(options: { planMode?: boolean; specMode?: boolean; tool?: CoderTool; input?: Record<string, unknown> } = {}) {
  const tool = options.tool ?? recordingTool;
  const registry = new ToolRegistry();
  registry.register(tool);
  return new CoderRunner({
    provider: new SingleToolUseProvider(tool.name, options.input ?? { path: 'src/foo.ts' }),
    registry,
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    planMode: options.planMode,
    specMode: options.specMode,
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  });
}

describe('runner + policy integration', () => {
  it('emits blocked with reason="plan_mode" when a mutating tool runs unapproved', async () => {
    const runner = makeRunner({ planMode: true });
    const blocked: Array<{ tool: string; reason: string }> = [];
    runner.on('blocked', (p) => blocked.push({ tool: p.tool, reason: p.reason }));
    const callResults: Array<{ name: string; isError?: boolean }> = [];
    runner.on('tool_call_result', (_id, name, result) =>
      callResults.push({ name, isError: result.isError }),
    );
    await runner.run();
    expect(blocked).toEqual([{ tool: 'recording_writer', reason: 'plan_mode' }]);
    // The runner returns a synthetic error result so the model sees the refusal.
    expect(callResults).toEqual([{ name: 'recording_writer', isError: true }]);
  });

  it('lets a scope-aware mutating tool through when its path is inside the scope', async () => {
    const runner = makeRunner({ planMode: true, input: { path: 'src/foo.ts' } });
    runner.beginTaskScope({ id: 'task-1', files: ['src/foo.ts'] });
    const blocked: Array<{ reason: string }> = [];
    runner.on('blocked', (p) => blocked.push({ reason: p.reason }));
    const results: Array<{ name: string; content: string }> = [];
    runner.on('tool_call_result', (_id, name, result) =>
      results.push({ name, content: result.content }),
    );
    await runner.run();
    expect(blocked).toEqual([]);
    expect(results).toEqual([{ name: 'recording_writer', content: 'wrote something' }]);
  });

  it.each([false, true])('keeps spec approval independent of a scoped plan unlock (approved=%s)', async (approved) => {
    let writes = 0;
    const tool: CoderTool = {
      ...recordingTool,
      handler: async () => { writes++; return { content: 'wrote something' }; },
    };
    const runner = makeRunner({ planMode: true, specMode: true, tool });
    runner.beginTaskScope({ id: 'task-1', files: ['src/foo.ts'] });
    if (approved) runner.approveSpec('spec/task.md');
    const blocked: string[] = [];
    runner.on('blocked', (event) => blocked.push(event.reason));
    await runner.run();
    expect(writes).toBe(approved ? 1 : 0);
    expect(blocked).toEqual(approved ? [] : ['spec_mode']);
  });

  it('emits blocked with reason="task_scope" when the path is outside the scope', async () => {
    const runner = makeRunner({ planMode: true, input: { path: 'lib/elsewhere.ts' } });
    runner.beginTaskScope({ id: 'task-1', files: ['src/foo.ts'] });
    const blocked: Array<{ reason: string; detail?: string }> = [];
    runner.on('blocked', (p) => blocked.push({ reason: p.reason, detail: p.detail }));
    await runner.run();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toBe('task_scope');
    expect(blocked[0].detail).toMatch(/lib\/elsewhere\.ts/);
  });

  it('runs a mutating tool freely outside plan mode (legacy parity)', async () => {
    const runner = makeRunner({ planMode: false });
    const blocked: Array<{ reason: string }> = [];
    runner.on('blocked', (p) => blocked.push({ reason: p.reason }));
    const results: Array<{ name: string; isError?: boolean }> = [];
    runner.on('tool_call_result', (_id, name, result) =>
      results.push({ name, isError: result.isError }),
    );
    await runner.run();
    expect(blocked).toEqual([]);
    expect(results).toEqual([{ name: 'recording_writer', isError: false }]);
  });
});
