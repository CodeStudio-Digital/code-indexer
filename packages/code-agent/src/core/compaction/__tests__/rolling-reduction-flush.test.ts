import { describe, it, expect } from 'vitest';
import { applyRollingReduction } from '@mcp/code-agent/core/compaction/rolling-reduction.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

/**
 * Tranche flush (mig 143 era). Retiring a stale duplicate rewrites an OLD
 * message in place, busting the provider prompt-cache from that point on —
 * session 991 lost ~80-90% of the cached prefix on T2/T3 of every round to
 * free ~2k chars. With `flushThresholdChars`, retirements accumulate and
 * apply in batches: BELOW the threshold the output must be byte-identical
 * (same reference, even) to the input; once a tranche completes, its whole
 * batch lands in ONE pass and the output stays stable again until the next.
 */

function readCall(id: string, path: string, content: string): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool_use', id, name: 'read_file',
        input: { path, start_line: null, end_line: null, symbol: null, around_line: null, max_lines: null },
      }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  ];
}

function searchCall(id: string, query: string): AgentMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__grep_code', input: { query } }] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: id, content: `hits for ${query}` }] },
  ];
}

/** Pad so the calls under test sit OUTSIDE the protected tail (last 6). */
function pad(messages: AgentMessage[], extras = 4): AgentMessage[] {
  const tail: AgentMessage[] = [];
  for (let i = 0; i < extras; i++) {
    tail.push({ role: 'user', content: [{ type: 'text', text: `pad-${i}` }] });
    tail.push({ role: 'assistant', content: [{ type: 'text', text: `ack-${i}` }] });
  }
  return [...messages, ...tail];
}

function resultOf(messages: AgentMessage[], useId: string): string {
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

const KB = (n: number) => 'X'.repeat(n);

/** N duplicate-read PAIRS of 1000-char results: dupe i retires pair i's first read. */
function dupes(n: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(...readCall(`A${i}`, `src/f${i}.ts`, KB(1000)));
    out.push(...readCall(`B${i}`, `src/f${i}.ts`, KB(1000)));
  }
  return out;
}

describe('applyRollingReduction — tranche flush', () => {
  it('below the threshold: output IS the input (same reference, zero mutations)', () => {
    const msgs = pad(dupes(2)); // 2k retirable < 2.5k threshold
    const r = applyRollingReduction(msgs, { flushThresholdChars: 2500 });
    expect(r.messages).toBe(msgs);
    expect(r.reduced).toBe(0);
    expect(r.pendingRetired).toBe(2);
    expect(r.pendingChars).toBe(2000);
  });

  it('crossing the threshold applies the completed tranche in ONE pass', () => {
    const msgs = pad(dupes(3)); // 3k retirable, threshold 2.5k → completed=2.5k → first 2 apply
    const r = applyRollingReduction(msgs, { flushThresholdChars: 2500 });
    expect(r.reduced).toBe(2);
    expect(r.freedChars).toBe(2000);
    expect(r.pendingRetired).toBe(1);
    expect(resultOf(r.messages, 'A0')).toMatch(/^\[duplicate-read elided\]/);
    expect(resultOf(r.messages, 'A1')).toMatch(/^\[duplicate-read elided\]/);
    expect(resultOf(r.messages, 'A2')).toBe(KB(1000)); // deferred — verbatim
  });

  it('is MONOTONIC as the conversation grows: applied set never shrinks, stays stable between tranches', () => {
    const at3 = applyRollingReduction(pad(dupes(3)), { flushThresholdChars: 2500 });
    const at4 = applyRollingReduction(pad(dupes(4)), { flushThresholdChars: 2500 }); // total 4k → completed 2.5k→ still 2 applied
    const at5 = applyRollingReduction(pad(dupes(5)), { flushThresholdChars: 2500 }); // total 5k → completed 5k → all 5
    expect(at3.reduced).toBe(2);
    expect(at4.reduced).toBe(2); // byte-stable between flushes
    expect(at5.reduced).toBe(5);
  });

  it('threshold 0 = legacy apply-immediately', () => {
    const r = applyRollingReduction(pad(dupes(2)), { flushThresholdChars: 0 });
    expect(r.reduced).toBe(2);
    expect(r.pendingRetired).toBe(0);
  });

  it('default opts (no threshold) = legacy apply-immediately', () => {
    const r = applyRollingReduction(pad(dupes(1)));
    expect(r.reduced).toBe(1);
  });

  it('is deterministic: same input → byte-identical output', () => {
    const msgs = pad(dupes(3));
    const a = applyRollingReduction(msgs, { flushThresholdChars: 2500 });
    const b = applyRollingReduction(msgs, { flushThresholdChars: 2500 });
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(a.reduced).toBe(b.reduced);
  });

  it('already-elided content is excluded entirely (no candidate, no pending chars)', () => {
    const msgs = pad([
      ...readCall('A0', 'src/f0.ts', '[duplicate-read elided] old marker'),
      ...readCall('B0', 'src/f0.ts', KB(1000)),
    ]);
    const r = applyRollingReduction(msgs, { flushThresholdChars: 100 });
    expect(r.messages).toBe(msgs);
    expect(r.reduced).toBe(0);
    expect(r.pendingRetired).toBe(0);
    expect(r.pendingChars).toBe(0);
  });

  it('searches follow the same deferral', () => {
    const msgs = pad([...searchCall('S1', 'foo'), ...searchCall('S2', 'bar')]);
    const deferred = applyRollingReduction(msgs, { flushThresholdChars: 100000 });
    expect(deferred.messages).toBe(msgs);
    expect(deferred.pendingRetired).toBe(1);
    const legacy = applyRollingReduction(msgs, { flushThresholdChars: 0 });
    expect(legacy.reduced).toBe(1);
    expect(resultOf(legacy.messages, 'S1')).toMatch(/^\[duplicate-read elided\]/);
    expect(resultOf(legacy.messages, 'S2')).toBe('hits for bar');
  });

  it('distinct slices of the same file never collapse (session 609 guard), with threshold on', () => {
    const msgs = pad([
      ...readCall('A', 'src/foo.ts', KB(500)),
      // different slice → not a duplicate
      [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'B', name: 'read_file', input: { path: 'src/foo.ts', start_line: 10, end_line: 20, symbol: null, around_line: null, max_lines: null } }] },
        { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'B', content: KB(500) }] },
      ] as AgentMessage[],
    ].flat());
    const r = applyRollingReduction(msgs, { flushThresholdChars: 0 });
    expect(r.reduced).toBe(0);
    expect(resultOf(r.messages, 'A')).toBe(KB(500));
  });
});
