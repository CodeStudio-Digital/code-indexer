import { describe, it, expect } from 'vitest';
import { applyRollingReduction } from '../core/coder/core/compaction.js';
import type { AgentMessage } from '../core/coder/core/messages.js';

/**
 * Regression test for session 609: the rolling reducer was deduplicating
 * by file path alone, so distinct chunks of the same file collapsed into
 * one. The agent then re-read everything in a loop because earlier chunks
 * were marked stale by later ones.
 *
 * After the fix, dedup uses path+slice so different ranges coexist.
 */

function readCall(opts: {
  id: string;
  path: string;
  start_line?: number;
  end_line?: number;
  symbol?: string;
  around_line?: number;
}): AgentMessage[] {
  const useId = opts.id;
  const input: Record<string, unknown> = {
    file_path: opts.path,
    start_line: opts.start_line ?? null,
    end_line: opts.end_line ?? null,
    symbol: opts.symbol ?? null,
    around_line: opts.around_line ?? null,
  };
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: useId, name: 'mcp__read_file', input }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: useId, content: `RESULT FOR ${useId}` }],
    },
  ];
}

function pad(messages: AgentMessage[], extras: number): AgentMessage[] {
  // The reducer protects the last 6 messages — pad with neutral user/asst
  // turns so the calls under test fall OUTSIDE the protected tail.
  const tail: AgentMessage[] = [];
  for (let i = 0; i < extras; i++) {
    tail.push({ role: 'user', content: [{ type: 'text', text: `pad-${i}` }] });
    tail.push({ role: 'assistant', content: [{ type: 'text', text: `ack-${i}` }] });
  }
  return [...messages, ...tail];
}

function findResult(messages: AgentMessage[], useId: string): string {
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && (b as { tool_use_id?: string }).tool_use_id === useId) {
        const c = (b as { content?: unknown }).content;
        return typeof c === 'string' ? c : '';
      }
    }
  }
  return '';
}

describe('applyRollingReduction — chunk-aware dedup (session 609 regression)', () => {
  it('keeps two reads of DIFFERENT ranges of the same file verbatim', () => {
    const path = 'src/foo.ts';
    const msgs = pad(
      [
        ...readCall({ id: 'A', path, start_line: 1, end_line: 79 }),
        ...readCall({ id: 'B', path, start_line: 80, end_line: 154 }),
      ],
      8,
    );
    const r = applyRollingReduction(msgs);
    // Neither retired — different slices carry different information.
    expect(r.reduced).toBe(0);
    expect(findResult(r.messages, 'A')).toBe('RESULT FOR A');
    expect(findResult(r.messages, 'B')).toBe('RESULT FOR B');
  });

  it('retires the EARLIER read when a later read covers the IDENTICAL slice', () => {
    const path = 'src/foo.ts';
    const msgs = pad(
      [
        ...readCall({ id: 'A', path, start_line: 1, end_line: 79 }),
        ...readCall({ id: 'B', path, start_line: 1, end_line: 79 }),
      ],
      8,
    );
    const r = applyRollingReduction(msgs);
    // Same exact slice → A is retired, B kept.
    expect(r.reduced).toBe(1);
    expect(findResult(r.messages, 'A')).toMatch(/^\[duplicate-read elided\]/);
    expect(findResult(r.messages, 'B')).toBe('RESULT FOR B');
  });

  it('reproduces session 609: 5 chunks rotated 3× each and NONE are retired', () => {
    // The bug caused 18-21x reads of each of 5 ranges. After the fix,
    // rotating reads of distinct chunks should never be retired even if
    // repeated across many turns — only EXACT same-slice repeats trigger
    // retirement.
    const path = 'src/app/itens-receita.component.ts';
    const ranges: Array<[number, number]> = [
      [1, 79], [80, 154], [155, 225], [350, 388], [500, 629],
    ];
    const calls: AgentMessage[] = [];
    let n = 0;
    for (let round = 0; round < 3; round++) {
      for (const [s, e] of ranges) {
        n += 1;
        calls.push(...readCall({ id: `R${n}`, path, start_line: s, end_line: e }));
      }
    }
    const msgs = pad(calls, 8);
    const r = applyRollingReduction(msgs);
    // 5 distinct slices × 3 rounds = 15 reads total. Each slice repeats 3×
    // identically → 2 retirements per slice = 10 retired. Each slice's
    // newest call is preserved.
    expect(r.reduced).toBe(10);
    // Last call of each slice is kept (round=2).
    for (let s = 0; s < ranges.length; s++) {
      const lastCallId = `R${10 + s + 1}`; // round 2 starts at id R11..R15
      expect(findResult(r.messages, lastCallId)).toBe(`RESULT FOR ${lastCallId}`);
    }
  });

  it('different symbol args within the same file are kept distinct', () => {
    const path = 'src/foo.ts';
    const msgs = pad(
      [
        ...readCall({ id: 'A', path, symbol: 'doFoo' }),
        ...readCall({ id: 'B', path, symbol: 'doBar' }),
      ],
      8,
    );
    const r = applyRollingReduction(msgs);
    expect(r.reduced).toBe(0);
    expect(findResult(r.messages, 'A')).toBe('RESULT FOR A');
    expect(findResult(r.messages, 'B')).toBe('RESULT FOR B');
  });
});
