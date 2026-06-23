/**
 * Coverage for the docs_finish tool — terminal tool that signals the
 * DocsAgent has produced its final answer.
 *
 * Invariants:
 *   - Validates markdown, chunks_cited, confidence.
 *   - Writes the payload to the shared slot.
 *   - Calls runner.abort() so the run loop exits cleanly.
 *   - Refuses a second call (idempotency for in-flight runners).
 */
import { describe, it, expect, vi } from 'vitest';
import { makeDocsFinishTool, type DocsFinishSlot } from '../tools/docs-finish.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

function makeSlot(): DocsFinishSlot {
  return { payload: null };
}

function makeCtx(): ToolContext & { runner: { abort: ReturnType<typeof vi.fn> } } {
  const abort = vi.fn();
  return {
    cwd: '/tmp',
    projectName: 'docs-agent',
    runner: { abort } as unknown as ToolContext['runner'],
  } as ToolContext & { runner: { abort: ReturnType<typeof vi.fn> } };
}

describe('docs_finish', () => {
  it('rejects empty markdown', async () => {
    const slot = makeSlot();
    const tool = makeDocsFinishTool({ slot });
    const ctx = makeCtx();
    const result = await tool.handler(
      { markdown: '   ', chunks_cited: [1], confidence: 'high' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(slot.payload).toBeNull();
    expect(ctx.runner.abort).not.toHaveBeenCalled();
  });

  it('rejects unknown confidence values', async () => {
    const slot = makeSlot();
    const tool = makeDocsFinishTool({ slot });
    const ctx = makeCtx();
    const result = await tool.handler(
      { markdown: '# OK', chunks_cited: [], confidence: 'unsure' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(slot.payload).toBeNull();
  });

  it('writes the slot, aborts the runner, and returns ok on valid input', async () => {
    const slot = makeSlot();
    const tool = makeDocsFinishTool({ slot });
    const ctx = makeCtx();
    const result = await tool.handler(
      {
        markdown: '# Final answer\n\nDetails [^1].',
        chunks_cited: [101, 202, 303],
        confidence: 'high',
        notes: 'docs cover v15; older versions not indexed',
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(slot.payload).not.toBeNull();
    expect(slot.payload!.markdown).toContain('Final answer');
    expect(slot.payload!.chunks_cited).toEqual([101, 202, 303]);
    expect(slot.payload!.confidence).toBe('high');
    expect(slot.payload!.notes).toBe('docs cover v15; older versions not indexed');
    expect(ctx.runner.abort).toHaveBeenCalledTimes(1);
  });

  it('refuses a second call while the slot is filled', async () => {
    const slot = makeSlot();
    const tool = makeDocsFinishTool({ slot });
    const ctx = makeCtx();
    // First call succeeds.
    const first = await tool.handler(
      { markdown: '# A', chunks_cited: [1], confidence: 'medium' },
      ctx,
    );
    expect(first.isError).toBeFalsy();
    // Second call refused.
    const second = await tool.handler(
      { markdown: '# B', chunks_cited: [2], confidence: 'high' },
      ctx,
    );
    expect(second.isError).toBe(true);
    // Slot still holds the first payload.
    expect(slot.payload!.markdown).toContain('# A');
  });

  it('filters out non-positive chunk ids from chunks_cited', async () => {
    const slot = makeSlot();
    const tool = makeDocsFinishTool({ slot });
    const ctx = makeCtx();
    await tool.handler(
      {
        markdown: '# x',
        chunks_cited: [10, 0, -1, 'bad', 20],
        confidence: 'low',
      },
      ctx,
    );
    expect(slot.payload!.chunks_cited).toEqual([10, 20]);
  });

  it('does not crash when ctx has no runner (test/isolated invocations)', async () => {
    const slot = makeSlot();
    const tool = makeDocsFinishTool({ slot });
    // Strip the runner from ctx — simulates a unit test or sub-runner that
    // exercises the tool directly without a CoderRunner attached.
    const ctx: ToolContext = { cwd: '/tmp', projectName: 'docs-agent' };
    const result = await tool.handler(
      { markdown: '# answer', chunks_cited: [], confidence: 'low' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(slot.payload).not.toBeNull();
  });
});
