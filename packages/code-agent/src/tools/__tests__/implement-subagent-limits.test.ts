import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { runSubagent } from '../implement-subagent.js';

function tool(name = 'mock_tool'): CoderTool {
  return {
    name,
    description: 'mock tool',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
  };
}

function parent(provider: ChatProvider, tools: CoderTool[] = [tool()]) {
  return {
    provider,
    tools,
    ctx: {
      cwd: process.cwd(),
      projectName: 'test',
    } as ToolContext,
  };
}

function toolCallingProvider(): ChatProvider {
  let call = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      call++;
      yield { type: 'tool_call_start', id: `tu_${call}`, name: 'mock_tool' };
      yield { type: 'tool_call_end', id: `tu_${call}`, name: 'mock_tool', input: {} };
      yield { type: 'done', stop_reason: 'tool_use' };
    },
  };
}

function hangingProvider(): ChatProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      await new Promise(() => {
        /* never resolves */
      });
    },
  };
}

describe('runSubagent limits', () => {
  beforeEach(() => {
    process.env.CODER_SUBAGENT_SALVAGE_TIMEOUT_MS = '20';
  });

  afterEach(() => {
    delete process.env.CODER_SUBAGENT_SALVAGE_TIMEOUT_MS;
  });

  it('returns an error result when the tool cap is reached', async () => {
    const progress: string[] = [];
    const result = await runSubagent(parent(toolCallingProvider()), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'call tools' }] }],
      maxTurns: 10,
      limits: { maxToolCalls: 1, timeoutMs: 5_000, stallMs: 5_000 },
      onProgress: (p) => {
        if (p.note) progress.push(p.note);
      },
    });

    expect(result.reason).toBe('error');
    expect(result.finalText).toContain('task tool limit reached');
    expect(progress.some((note) => note.includes('task tool limit reached'))).toBe(true);
  });

  it('returns an error result when the subagent stalls', async () => {
    const result = await runSubagent(parent(hangingProvider(), []), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'hang' }] }],
      maxTurns: 10,
      limits: { timeoutMs: 5_000, stallMs: 20 },
    });

    expect(result.reason).toBe('error');
    expect(result.finalText).toContain('subagent stalled');
  });
});
