import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  alignedDurablePrefix,
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

  it('serializes concurrent checkpoints for one session', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = serializeSessionCompaction(9, async () => {
      order.push('first:start');
      firstStarted();
      await gate;
      order.push('first:end');
    });
    await started;
    const second = serializeSessionCompaction(9, async () => {
      order.push('second:start');
      order.push('second:end');
    });
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});
