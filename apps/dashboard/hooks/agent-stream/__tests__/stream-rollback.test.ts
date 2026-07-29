/**
 * A provider call that dies mid-stream already rendered its deltas, but its
 * output never reaches `assistantContent` — so the retry re-reasons from the
 * same transcript and streams a near-identical replacement. Without retracting
 * the failed attempt the user sees both, stacked.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import { rollbackStreamedChars } from '../stream-rollback.js';
import type { SessionId, StreamBlock, UpdateSession } from '../types.js';

const SID = '66666666-6666-4666-8666-666666666666' as SessionId;

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  const handlers = createEventHandlers({
    sid: SID,
    blocks,
    toolIndex,
    flush: vi.fn(),
    flushNow: vi.fn(),
    updateSession: vi.fn() as UpdateSession,
  });
  return { blocks, toolIndex, handlers };
}

const textOf = (blocks: StreamBlock[], type: 'text' | 'thinking') =>
  blocks.filter((b) => b.type === type).map((b) => (b as { text: string }).text);

describe('rollbackStreamedChars', () => {
  it('removes a block consumed in full and truncates the one it lands inside', () => {
    const blocks: StreamBlock[] = [
      { type: 'thinking', text: 'keep' },
      { type: 'thinking', text: 'discard' },
    ];
    expect(rollbackStreamedChars(blocks, 'thinking', 'discard'.length + 2)).toBe(true);
    expect(textOf(blocks, 'thinking')).toEqual(['ke']);
  });

  it('ignores a zero or malformed count', () => {
    const blocks: StreamBlock[] = [{ type: 'text', text: 'intact' }];
    expect(rollbackStreamedChars(blocks, 'text', 0)).toBe(false);
    expect(rollbackStreamedChars(blocks, 'text', Number.NaN)).toBe(false);
    expect(textOf(blocks, 'text')).toEqual(['intact']);
  });

  it('never eats past a dispatched tool into durable content', () => {
    // Everything above a dispatched tool belongs to an attempt that already
    // completed and persisted — a miscounted payload must not reach it.
    const blocks: StreamBlock[] = [
      { type: 'text', text: 'durable answer' },
      { type: 'tool', call: { id: 't1', name: 'read_file', input: {}, status: 'done' } } as StreamBlock,
      { type: 'text', text: 'partial' },
    ];
    expect(rollbackStreamedChars(blocks, 'text', 999)).toBe(true);
    expect(textOf(blocks, 'text')).toEqual(['durable answer']);
  });

  it('leaves other block types untouched', () => {
    const blocks: StreamBlock[] = [
      { type: 'thinking', text: 'reasoning' },
      { type: 'text', text: 'answer' },
    ];
    rollbackStreamedChars(blocks, 'text', 'answer'.length);
    expect(textOf(blocks, 'thinking')).toEqual(['reasoning']);
    expect(textOf(blocks, 'text')).toEqual([]);
  });
});

describe('stream_rollback handler', () => {
  it('retracts the failed attempt so only the retry remains', () => {
    const { blocks, handlers } = setup();
    handlers.thinking({ text: 'Analyzing the installer' }, 'thinking');
    handlers.text({ text: 'Partial answer' }, 'text');

    handlers.stream_rollback(
      { textChars: 'Partial answer'.length, thinkingChars: 'Analyzing the installer'.length, reason: 'ProviderError' },
      'stream_rollback',
    );
    expect(blocks).toHaveLength(0);

    // The retry re-reasons from scratch — near-identical, but now the only copy.
    handlers.thinking({ text: 'Analyzing the installer' }, 'thinking');
    expect(textOf(blocks, 'thinking')).toEqual(['Analyzing the installer']);
  });

  it('keeps the tool index consistent after splicing blocks away', () => {
    const { blocks, toolIndex, handlers } = setup();
    handlers.tool_call_start({ id: 'tool-1', name: 'read_file' }, 'tool_call_start');
    handlers.thinking({ text: 'orphaned' }, 'thinking');
    handlers.stream_rollback({ textChars: 0, thinkingChars: 'orphaned'.length }, 'stream_rollback');

    expect(blocks.filter((b) => b.type === 'thinking')).toHaveLength(0);
    const toolAt = toolIndex.get('tool-1');
    expect(toolAt).toBeDefined();
    expect(blocks[toolAt as number]).toMatchObject({ type: 'tool' });
  });

  it('is a no-op when the attempt streamed nothing', () => {
    const { blocks, handlers } = setup();
    handlers.thinking({ text: 'untouched' }, 'thinking');
    handlers.stream_rollback({ textChars: 0, thinkingChars: 0 }, 'stream_rollback');
    expect(textOf(blocks, 'thinking')).toEqual(['untouched']);
  });
});
