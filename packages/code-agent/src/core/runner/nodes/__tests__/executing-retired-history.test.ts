/**
 * A session resumed with child chats on and a spawn_agent call in its
 * history: the old call and its result go to the provider unchanged, and a
 * new spawn_agent call (no longer registered) gets the replacement
 * instruction as its tool result instead of failing the turn.
 */
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { REPLACED_BY_CHILD_CHATS } from '@mcp/code-agent/tools/child-chat-surface.js';
import { ExecutingNode } from '../executing.js';
import { makeTestContext } from './test-helpers.js';

describe('resumed session with a retired tool in its history', () => {
  it('replays the old call and answers a new one with its replacement', async () => {
    const seen: ChatRequest[] = [];
    const registry = new ToolRegistry();
    registry.setReplacedTools(REPLACED_BY_CHILD_CHATS);
    const { ctx } = makeTestContext({
      provider: { name: 'mock', model: 'claude-haiku-4-5-20251001', setModel() {}, async *chat(request: ChatRequest) {
        seen.push(request);
        yield { type: 'tool_call_start', id: 'new-1', name: 'spawn_agent' };
        yield { type: 'tool_call_end', id: 'new-1', name: 'spawn_agent', input: { agents: [{ task: 'look' }] } };
        yield { type: 'done', stop_reason: 'tool_use' };
      } },
      registry,
      toolContext: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
    });
    ctx.messages.push(
      { role: 'user', content: [{ type: 'text', text: 'Investigate.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old-1', name: 'spawn_agent', input: { agents: [{ task: 'old' }] } }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'old-1', content: 'Old summary.' }] } as never,
    );
    await new ExecutingNode().execute(ctx, null);
    expect(JSON.stringify(seen[0]!.messages)).toContain('"old-1"');
    expect(JSON.stringify(seen[0]!.messages)).toContain('Old summary.');
    const reply = JSON.stringify(ctx.messages.at(-1)!.content);
    expect(reply).toContain('spawn_agent was retired.');
    expect(reply).toContain('Use create_chat with');
  });
});
