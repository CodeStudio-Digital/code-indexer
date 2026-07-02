/**
 * repairToolPairing — extracted verbatim from compactHistoryForLLM so the
 * subagent resume path can sanitize captured transcripts. These tests lock
 * in the three passes (orphan tool_result removal, synthetic tool_result
 * injection for orphaned tool_use — merge and inject variants — and
 * consecutive same-role merge), plus idempotency and input immutability,
 * which the resume path relies on.
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { repairToolPairing } from '@mcp/code-agent/core/transcript-repair.js';

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantWithTools(tools: Array<{ id: string; name: string }>, text = 'working'): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      ...tools.map((t) => ({ type: 'tool_use' as const, id: t.id, name: t.name, input: {} })),
    ],
  } as AgentMessage;
}

function toolMsg(results: Array<{ id: string; text?: string }>): AgentMessage {
  return {
    role: 'tool',
    content: results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.id,
      content: r.text ?? `result ${r.id}`,
    })),
  } as AgentMessage;
}

function allToolUseIds(messages: AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) if (b.type === 'tool_use') ids.add(b.id);
  }
  return ids;
}

function allToolResultIds(messages: AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') ids.add((b as { tool_use_id: string }).tool_use_id);
    }
  }
  return ids;
}

describe('repairToolPairing', () => {
  it('drops orphaned tool_results whose tool_use is gone', () => {
    const messages = [
      user('go'),
      assistantWithTools([{ id: 't1', name: 'read_file' }]),
      toolMsg([{ id: 't1' }, { id: 'ghost' }]),
    ];
    const out = repairToolPairing(messages);
    expect(allToolResultIds(out)).toEqual(new Set(['t1']));
  });

  it('removes a tool message entirely when every result is orphaned', () => {
    const messages = [user('go'), toolMsg([{ id: 'ghost' }])];
    const out = repairToolPairing(messages);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('injects a synthetic error result for a dangling trailing tool_use', () => {
    const messages = [
      user('go'),
      assistantWithTools([{ id: 't1', name: 'run_command' }]),
    ];
    const out = repairToolPairing(messages);
    const last = out[out.length - 1];
    expect(last.role).toBe('tool');
    const block = last.content[0] as { type: string; tool_use_id: string; content: string; is_error: boolean };
    expect(block.tool_use_id).toBe('t1');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('run_command');
  });

  it('merges synthetic results into a partially-covering tool message', () => {
    const messages = [
      user('go'),
      assistantWithTools([{ id: 't1', name: 'read_file' }, { id: 't2', name: 'edit_file' }]),
      toolMsg([{ id: 't1' }]),
    ];
    const out = repairToolPairing(messages);
    // No NEW tool message — t2's synthetic result merged into the existing one.
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(allToolResultIds(out)).toEqual(new Set(['t1', 't2']));
    const toolMessage = out.find((m) => m.role === 'tool')!;
    const synthetic = toolMessage.content.find(
      (b) => b.type === 'tool_result' && (b as { tool_use_id?: string }).tool_use_id === 't2',
    ) as { is_error?: boolean };
    expect(synthetic.is_error).toBe(true);
  });

  it('uses the caller-provided note for synthetic results', () => {
    const messages = [user('go'), assistantWithTools([{ id: 't1', name: 'glob' }])];
    const out = repairToolPairing(messages, (name) => `[Interrupted — ${name} was mid-flight]`);
    const last = out[out.length - 1];
    const block = last.content[0] as { content: string };
    expect(block.content).toBe('[Interrupted — glob was mid-flight]');
  });

  it('merges consecutive same-role messages', () => {
    const messages = [user('first'), user('second'), assistantWithTools([], 'a'), { role: 'assistant', content: [{ type: 'text', text: 'b' }] } as AgentMessage];
    const out = repairToolPairing(messages);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toHaveLength(2);
    expect(out[1].role).toBe('assistant');
  });

  it('is idempotent', () => {
    const messages = [
      user('go'),
      assistantWithTools([{ id: 't1', name: 'read_file' }, { id: 't2', name: 'edit_file' }]),
      toolMsg([{ id: 't1' }, { id: 'ghost' }]),
      user('extra'),
      user('extra2'),
    ];
    const once = repairToolPairing(messages);
    const twice = repairToolPairing(once);
    expect(twice).toEqual(once);
    // Every tool_use paired after one pass.
    expect(allToolResultIds(once)).toEqual(allToolUseIds(once));
  });

  it('does not mutate the input array or its messages', () => {
    const messages = [
      user('go'),
      assistantWithTools([{ id: 't1', name: 'read_file' }]),
      toolMsg([{ id: 'ghost' }]),
      user('tail'),
      user('tail2'),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    repairToolPairing(messages);
    expect(messages).toEqual(snapshot);
  });
});
