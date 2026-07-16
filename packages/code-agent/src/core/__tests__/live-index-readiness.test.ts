import { describe, expect, it } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import {
  buildSystemPrompt,
  promoteIndexReadySystemPrompt,
  type PromptContext,
} from '@mcp/code-agent/core/system-prompt.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

class TwoTurnProvider implements ChatProvider {
  readonly name = 'test';
  model = 'test-model';
  readonly prompts: string[] = [];
  private call = 0;

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
    this.prompts.push(request.system);
    this.call += 1;
    if (this.call === 1) {
      yield { type: 'tool_call_start', id: 'ready-1', name: 'finish_index' };
      yield { type: 'tool_call_end', id: 'ready-1', name: 'finish_index', input: {} };
      yield { type: 'done', stop_reason: 'tool_use' };
      return;
    }
    yield { type: 'text_delta', text: 'done' };
    yield { type: 'done', stop_reason: 'end_turn' };
  }
}

const PROMPT_CONTEXT: PromptContext = {
  projectName: 'FreshProject',
  projectRoot: 'D:/fresh-project',
  os: 'win32',
  providerFamily: 'openai',
  profile: 'navigate',
  mcpAvailable: true,
  isIndexed: false,
  sessionDrive: true,
  agentLoopV2: true,
};

describe('live structural readiness', () => {
  it('promotes the same runner once before its next internal model turn', async () => {
    const provider = new TwoTurnProvider();
    const registry = new ToolRegistry();
    let baselineReady = false;
    registry.register({
      name: 'finish_index',
      description: 'test-only baseline completion',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: false,
      handler: async () => {
        baselineReady = true;
        return { content: 'baseline ready' };
      },
    });
    const toolContext: ToolContext = {
      cwd: 'D:/fresh-project',
      projectName: 'FreshProject',
      projectIndexed: false,
    };
    let prompt = buildSystemPrompt(PROMPT_CONTEXT);
    const runner = new CoderRunner({
      provider,
      registry,
      systemPrompt: prompt,
      toolContext,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] }],
    });

    let promotions = 0;
    runner.on('turn_start', () => {
      if (!baselineReady || toolContext.projectIndexed) return;
      toolContext.projectIndexed = true;
      prompt = promoteIndexReadySystemPrompt(prompt, {
        mcpAvailable: true,
        sessionDrive: true,
        repoMap: '# Repo map (top-level symbols, recent files first)\n- src/app.ts: function main',
      });
      runner.setSystemPromptForNextTurn(prompt);
      promotions += 1;
    });

    const toolNamesBefore = registry.list().map((tool) => tool.name);
    await runner.run();

    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[0]).toContain('INDEX_NOT_READY');
    expect(provider.prompts[1]).not.toContain('INDEX_NOT_READY');
    expect(provider.prompts[1]).toContain('# Repo map (top-level symbols');
    expect(toolContext.projectIndexed).toBe(true);
    expect(promotions).toBe(1);
    expect(registry.list().map((tool) => tool.name)).toEqual(toolNamesBefore);
  });
});
