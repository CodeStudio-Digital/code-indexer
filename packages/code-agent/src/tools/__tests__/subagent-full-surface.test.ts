/**
 * A `full` child inherits the parent's tools, except what a child must never
 * own: a nested reviewer (`request_review`), the parent's inline task scope
 * (`task_complete`; a child runner never has one open) and the interactive
 * tools that pause for the user (ask_user, decision_gate, submit_plan,
 * task_list). Children do not talk to the user; the parent does.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { runSubagent } from '../implement-subagent.js';

const CALLS = ['read_file', 'request_review', 'task_complete', 'ask_user', 'decision_gate', 'submit_plan', 'task_list'];

function stubTool(name: string, interactive = false): CoderTool {
  return {
    name, source: 'native', description: `${name} fixture`, parameters: { type: 'object', properties: {} },
    mutates: false, riskLevel: 'read', ...(interactive ? { interactive: true } : {}),
    handler: vi.fn(async () => ({ content: `${name} ran` })),
  };
}

function callingProvider(): ChatProvider {
  let turn = 0;
  return {
    name: 'fixture', model: 'fixture', setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      if (++turn === 1) {
        for (const name of CALLS) {
          yield { type: 'tool_call_start', id: `tu_${name}`, name };
          yield { type: 'tool_call_end', id: `tu_${name}`, name, input: {} };
        }
        yield { type: 'done', stop_reason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', stop_reason: 'end_turn' };
    },
  };
}

describe('full subagent tool surface', () => {
  it('runs inherited tools but never request_review, task_complete or interactive tools', async () => {
    const tools = [
      stubTool('read_file'),
      stubTool('request_review'),
      stubTool('task_complete'),
      stubTool('ask_user', true),
      stubTool('decision_gate', true),
      stubTool('submit_plan', true),
      stubTool('task_list', true),
    ];
    const result = await runSubagent(
      { provider: callingProvider(), tools, ctx: { cwd: process.cwd(), projectName: 'test' } as ToolContext },
      { systemPrompt: 'Do the task', profile: 'full', allowlist: null, maxTurns: 3,
        initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Do the task' }] }] },
    );

    expect(result.reason).toBe('completed');
    const ran = Object.fromEntries(tools.map((tool) => [tool.name, vi.mocked(tool.handler).mock.calls.length > 0]));
    expect(ran).toEqual({
      read_file: true,
      request_review: false,
      task_complete: false,
      ask_user: false,
      decision_gate: false,
      submit_plan: false,
      task_list: false,
    });
  });
});
