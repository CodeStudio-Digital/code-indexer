import { describe, expect, it } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type {
  ChatProvider,
  ChatRequest,
} from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

class NoopProvider implements ChatProvider {
  readonly name = 'live-settings-test';
  model = 'live-settings-test-1';

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(_request: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'done' };
  }
}

describe('CoderRunner live settings', () => {
  it('applies permission and output-cap changes without rebuilding the runner', () => {
    const toolContext: ToolContext = {
      cwd: process.cwd(),
      projectName: 'live-settings-test',
    };
    const runner = new CoderRunner({
      provider: new NoopProvider(),
      registry: new ToolRegistry(),
      systemPrompt: 'test',
      toolContext,
      toolOutputCapLevel: 'economic',
    });
    const economicCap = runner.effectivePushTimeCap;
    const economicInlineCap = toolContext.toolOutputInlineCap;

    expect(runner.getToolPermissionMode()).toBe('auto');
    runner.setToolPermissionMode('unrestricted');
    expect(runner.getToolPermissionMode()).toBe('unrestricted');

    runner.setToolOutputCapLevel('ultra');
    expect(runner.effectivePushTimeCap).toBeGreaterThan(economicCap);
    expect(toolContext.toolOutputInlineCap).toBeGreaterThan(
      economicInlineCap ?? 0,
    );

    runner.setToolOutputCapLevel('economic');
    expect(runner.effectivePushTimeCap).toBe(economicCap);
    expect(toolContext.toolOutputInlineCap).toBe(economicInlineCap);
  });

  it('reports unlimited by default and accepts session limits before a run', async () => {
    const runner = new CoderRunner({
      provider: new NoopProvider(),
      registry: new ToolRegistry(),
      systemPrompt: 'test',
      toolContext: {
        cwd: process.cwd(),
        projectName: 'live-run-limits-test',
      },
    });
    const starts: Array<{ maxTurns: number | null }> = [];
    runner.on('run_started', (payload) => starts.push(payload));

    runner.setRunLimits(null, 15);
    await runner.run();

    expect(starts).toEqual([
      expect.objectContaining({ maxTurns: null }),
    ]);
  });
});
