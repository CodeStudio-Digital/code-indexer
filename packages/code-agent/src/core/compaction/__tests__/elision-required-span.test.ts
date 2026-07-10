/**
 * allPriorReadsElided + requiredSpan — honesty fix for the exact-slice
 * pre-read guard. A prior read whose live tool_result no longer SHOWS every
 * requested line (the reducer/finalize cap trims tails AFTER the ledger
 * records the header range) must count as elided, so the guard allows a
 * fresh read instead of refusing with "content is already in your context"
 * (observed 2026-07-09: a `[lines 550-1000]` serve truncated at ~761).
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { allPriorReadsElided } from '@mcp/code-agent/core/compaction/elision.js';

function toolResult(useId: string, content: string): AgentMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: useId, content }],
  } as AgentMessage;
}

/** Read result with the ORIGINAL header range but a body ending early. */
function readContent(headerEnd: number, bodyStart: number, bodyEnd: number): string {
  const lines = Array.from(
    { length: bodyEnd - bodyStart + 1 },
    (_, i) => `${(bodyStart + i).toString().padStart(5)}\tx`,
  );
  return `a.ts | 1000 lines | ts\n[lines ${bodyStart}-${headerEnd}]\n${lines.join('\n')}`;
}

describe('allPriorReadsElided — requiredSpan', () => {
  it('a live, fully-covering prior keeps the guard active (returns false)', () => {
    const messages = [toolResult('u1', readContent(1000, 550, 1000))];
    expect(allPriorReadsElided([{ useId: 'u1' }], messages, { start: 760, end: 900 })).toBe(false);
  });

  it('a truncated prior counts as elided for spans past the visible end', () => {
    const truncated =
      readContent(1000, 550, 761) + '\n[truncated — get_tool_output("o1") for the rest]';
    const messages = [toolResult('u1', truncated)];
    expect(allPriorReadsElided([{ useId: 'u1' }], messages, { start: 760, end: 900 })).toBe(true);
    // ...but still counts as present for the span it does show.
    expect(allPriorReadsElided([{ useId: 'u1' }], messages, { start: 600, end: 750 })).toBe(false);
  });

  it('unparseable prior content (diff/pointer) counts as elided under a span', () => {
    const messages = [toolResult('u1', '[reread-after-edit] `a.ts` was mutated...\n-old\n+new')];
    expect(allPriorReadsElided([{ useId: 'u1' }], messages, { start: 1, end: 10 })).toBe(true);
  });

  it('without requiredSpan the legacy presence-only check is unchanged', () => {
    const truncated = readContent(1000, 550, 761) + '\n[truncated]';
    expect(allPriorReadsElided([{ useId: 'u1' }], [toolResult('u1', truncated)])).toBe(false);
    expect(allPriorReadsElided([{ useId: 'u1' }], [toolResult('u1', '[compacted: gone]')])).toBe(
      true,
    );
  });

  it('one covering prior among truncated ones keeps the guard active', () => {
    const messages = [
      toolResult('u1', readContent(1000, 550, 761) + '\n[truncated]'),
      toolResult('u2', readContent(1000, 550, 1000)),
    ];
    expect(
      allPriorReadsElided([{ useId: 'u1' }, { useId: 'u2' }], messages, { start: 760, end: 900 }),
    ).toBe(false);
  });
});
