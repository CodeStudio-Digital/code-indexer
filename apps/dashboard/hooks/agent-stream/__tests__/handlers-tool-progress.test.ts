import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import type { StreamBlock, ToolCallEvent, UpdateSession } from '../types.js';

/**
 * Pure-handler tests for the `tool_progress` event added in commit 3.
 *
 * The handler updates the in-flight tool block's `elapsedMs` / `progressNote`
 * and triggers a flush so the live "running Xs" indicator and the progress
 * banner refresh. These tests pin down the contract without booting React.
 */

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  const flush = vi.fn();
  const flushNow = vi.fn();
  const updateSession: UpdateSession = vi.fn();
  const handlers = createEventHandlers({
    sid: 1,
    blocks,
    toolIndex,
    flush,
    flushNow,
    updateSession,
  });
  return { handlers, blocks, toolIndex, flush, flushNow, updateSession };
}

function getToolCall(blocks: StreamBlock[], id: string): ToolCallEvent | undefined {
  for (const b of blocks) {
    if (b.type === 'tool' && b.call.id === id) return b.call;
  }
  return undefined;
}

describe('tool_progress handler', () => {
  it('updates elapsedMs on the matching running block and triggers a flush', () => {
    const { handlers, blocks, flush } = setup();
    handlers.tool_call_start({ id: 'c1', name: 'docs_deep_research', input: {} }, 'tool_call_start');
    flush.mockClear();
    handlers.tool_progress({ id: 'c1', name: 'docs_deep_research', elapsedMs: 5_000 }, 'tool_progress');
    expect(flush).toHaveBeenCalledTimes(1);
    const call = getToolCall(blocks, 'c1');
    expect(call?.elapsedMs).toBe(5_000);
    expect(call?.progressNote).toBeUndefined();
  });

  it('sets progressNote when the heartbeat carries a note', () => {
    const { handlers, blocks } = setup();
    handlers.tool_call_start({ id: 'c1', name: 'docs_deep_research' }, 'tool_call_start');
    handlers.tool_progress(
      { id: 'c1', name: 'docs_deep_research', elapsedMs: 8_000, note: 'fetched 3/10 chunks' },
      'tool_progress',
    );
    const call = getToolCall(blocks, 'c1');
    expect(call?.elapsedMs).toBe(8_000);
    expect(call?.progressNote).toBe('fetched 3/10 chunks');
  });

  it('preserves a previous note when a noteless heartbeat arrives next', () => {
    const { handlers, blocks } = setup();
    handlers.tool_call_start({ id: 'c1', name: 'rag_search_docs' }, 'tool_call_start');
    handlers.tool_progress(
      { id: 'c1', name: 'rag_search_docs', elapsedMs: 3_000, note: 'reranking' },
      'tool_progress',
    );
    handlers.tool_progress(
      { id: 'c1', name: 'rag_search_docs', elapsedMs: 8_000 },
      'tool_progress',
    );
    const call = getToolCall(blocks, 'c1');
    expect(call?.elapsedMs).toBe(8_000);
    expect(call?.progressNote).toBe('reranking'); // still there
  });

  it('is a no-op for an unknown id (late event arriving after result)', () => {
    const { handlers, flush } = setup();
    handlers.tool_progress({ id: 'unknown', name: 'x', elapsedMs: 100 }, 'tool_progress');
    expect(flush).not.toHaveBeenCalled();
  });

  it('ignores heartbeats that land after the tool finished', () => {
    const { handlers, blocks, flush } = setup();
    handlers.tool_call_start({ id: 'c1', name: 'read_file' }, 'tool_call_start');
    handlers.tool_call_result(
      { id: 'c1', result: { content: 'ok' }, duration_ms: 42 },
      'tool_call_result',
    );
    flush.mockClear();
    // Late heartbeat — should be silently dropped, not reanimate the block.
    handlers.tool_progress({ id: 'c1', name: 'read_file', elapsedMs: 999 }, 'tool_progress');
    expect(flush).not.toHaveBeenCalled();
    const call = getToolCall(blocks, 'c1');
    expect(call?.status).toBe('done');
    expect(call?.elapsedMs).toBeUndefined(); // cleared by tool_call_result
  });

  it('stamps startedAt on tool_call_start so the UI can compute elapsed client-side', () => {
    const { handlers, blocks } = setup();
    const before = Date.now();
    handlers.tool_call_start({ id: 'c1', name: 'grep' }, 'tool_call_start');
    const after = Date.now();
    const call = getToolCall(blocks, 'c1');
    expect(call?.startedAt).toBeDefined();
    expect(call!.startedAt!).toBeGreaterThanOrEqual(before);
    expect(call!.startedAt!).toBeLessThanOrEqual(after);
  });
});
