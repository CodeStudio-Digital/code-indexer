import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { asSessionId } from '@mcp/session-storage';
import {
  alignedDurablePrefix,
  persistChapterCheckpoint,
  recedePrefixToToolPairBoundary,
  serializeSessionCompaction,
} from '../chapter-checkpoint.js';

function message(role: AgentMessage['role'], text: string): AgentMessage {
  return { role, content: [{ type: 'text', text }] };
}

describe('chapter checkpoint alignment', () => {
  it('skips synthetic resume data but maps only a contiguous durable prefix', () => {
    const durable = [message('user', 'one'), message('assistant', 'two'), message('user', 'three')];
    const head = [
      message('user', '[auto-compacted summary of older turns]'),
      durable[0],
      durable[1],
      message('user', 'runtime-only reminder'),
    ];
    expect(alignedDurablePrefix(durable, head)).toBe(2);
  });

  it('never skips an unseen durable row to advance the boundary', () => {
    const durable = [message('user', 'missing'), message('assistant', 'present')];
    expect(alignedDurablePrefix(durable, [durable[1]])).toBe(0);
  });

  it('ignores persistence-only tool metadata but not changed tool content', () => {
    const durable: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result', tool_use_id: 'call-1', content: 'same output',
        is_error: false, truncated: true, originalSize: 123,
      }],
    };
    const live: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result', tool_use_id: 'call-1', content: 'same output',
        truncated: true, originalSize: 999,
      }],
    };

    expect(alignedDurablePrefix([durable], [live])).toBe(1);
    const changed: AgentMessage = {
      role: 'tool',
      content: [{
        type: 'tool_result', tool_use_id: 'call-1', content: 'different output',
        truncated: true, originalSize: 999,
      }],
    };
    expect(alignedDurablePrefix([durable], [changed])).toBe(0);

    const durableUse: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-2', name: 'inspect', input: { originalSize: 1 } }],
    };
    const changedUse: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-2', name: 'inspect', input: { originalSize: 2 } }],
    };
    expect(alignedDurablePrefix([durableUse], [changedUse])).toBe(0);
  });

  it('recedes instead of splitting an assistant/tool pair', () => {
    const use: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }],
    };
    const result: AgentMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'body' }],
    };
    const messages = [message('user', 'before'), use, result, message('assistant', 'after')];

    expect(recedePrefixToToolPairBoundary(messages, 2)).toBe(1);
    expect(recedePrefixToToolPairBoundary(messages, 3)).toBe(3);
  });

  it('persists the receded pair-safe boundary rather than the raw aligned prefix', async () => {
    const before = message('user', 'before');
    const use: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }],
    };
    const result: AgentMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'body' }],
    };
    const commitConversationChapter = vi.fn().mockResolvedValue({
      status: 'committed',
      boundary_seq: 10,
      pruned_count: 1,
      chapter: { id: '11111111-1111-4111-8111-111111111111' },
    });
    const store = {
      loadSessionWithMessages: () => ({
        session: { summary_boundary_id: null },
        messages: [before, use, result],
        message_rows: [{ seq: 10 }, { seq: 11 }, { seq: 12 }],
      }),
      commitConversationChapter,
    } as unknown as FsSessionStore;

    await persistChapterCheckpoint({
      store,
      sessionId: asSessionId('22222222-2222-4222-8222-222222222222'),
      summary: {
        version: 3,
        chapter: {
          title: 'safe', summary: '', user_requests: [], decisions: [],
          work_completed: [], files: [], open_issues: [], resolved_issues: [],
        },
        resume: {
          objective: 'safe', current_focus: '', constraints: [], pending_tasks: [], next_step: '',
        },
      },
      headMessages: [before, use],
    });

    expect(commitConversationChapter).toHaveBeenCalledWith(expect.objectContaining({
      startMessageSeq: 10,
      endMessageSeq: 10,
    }));
  });

  it('serializes concurrent checkpoints for one session', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sessionId = asSessionId(
      '99999999-9999-4999-8999-999999999999',
    );
    const first = serializeSessionCompaction(sessionId, async () => {
      order.push('first:start');
      firstStarted();
      await gate;
      order.push('first:end');
    });
    await started;
    const second = serializeSessionCompaction(sessionId, async () => {
      order.push('second:start');
      order.push('second:end');
    });
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});
