/**
 * Unit tests for `spillOversizedToolResults` (P1).
 *
 * The helper is what lets the Compacting node escape a `compact_exhausted`
 * deadlock: when a single recent `tool_result` exceeds the protected tail,
 * the summarizer can't shrink it, so we deterministically spill it to the
 * side-file store and leave a recovery marker inline.
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { estimateBlockTokens } from '@mcp/code-agent/core/token-accounting.js';
import { spillOversizedToolResults } from '../spill-oversized.js';

function toolMsg(content: string, id = 'tu1'): AgentMessage {
  return { role: 'tool', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}
function toolMsgMulti(contents: string[]): AgentMessage {
  return {
    role: 'tool',
    content: contents.map((c, i) => ({ type: 'tool_result', tool_use_id: 'tu' + i, content: c })),
  };
}
function msgTokens(m: AgentMessage): number {
  let t = 0;
  for (const b of m.content) t += estimateBlockTokens(b);
  return t;
}
function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function makeStore() {
  const puts: string[] = [];
  return {
    puts,
    store: { put: (c: string) => { puts.push(c); return `oid-${puts.length}`; } },
  };
}

describe('spillOversizedToolResults', () => {
  it('spills a tool_result larger than protectTokens and leaves a recovery marker', () => {
    const big = 'x'.repeat(4000); // ~1000 tokens >> protect
    const { store, puts } = makeStore();
    const messages = [user('hi'), toolMsg(big)];

    const res = spillOversizedToolResults({ messages, protectTokens: 100, store });

    expect(res.spilled).toBe(1);
    expect(res.freedChars).toBeGreaterThan(0);
    expect(puts).toEqual([big]); // raw content cached for recovery
    const block = res.messages[1].content[0] as { content: string };
    expect(block.content.length).toBeLessThan(big.length);
    expect(block.content).toContain('[truncated');
    // The marker names the side-file id and the exact-recovery tool; the
    // shared builder in pure-helpers.ts emits them as `output_id=<id>` +
    // `exact fallback: get_tool_output` rather than a literal call snippet.
    expect(block.content).toContain('output_id=oid-1');
    expect(block.content).toContain('get_tool_output');
  });

  it('leaves small tool_results and non-tool messages untouched', () => {
    const { store } = makeStore();
    const messages = [user('hi'), toolMsg('ok'), user('still here')];

    const res = spillOversizedToolResults({ messages, protectTokens: 100, store });

    expect(res.spilled).toBe(0);
    expect(res.messages[1].content[0]).toEqual(messages[1].content[0]);
    expect(res.messages[0]).toBe(messages[0]); // unchanged ref
  });

  it('does not mutate the input array', () => {
    const big = 'y'.repeat(4000);
    const { store } = makeStore();
    const messages = [toolMsg(big)];
    const before = messages[0].content[0];

    spillOversizedToolResults({ messages, protectTokens: 100, store });

    expect(messages[0].content[0]).toBe(before); // original block intact
  });

  it('is a no-op (copy) when no store is available', () => {
    const big = 'z'.repeat(4000);
    const messages = [toolMsg(big)];
    const res = spillOversizedToolResults({ messages, protectTokens: 100 });
    expect(res.spilled).toBe(0);
    expect(res.messages).not.toBe(messages); // returns a copy
    expect(res.messages[0]).toBe(messages[0]);
  });

  it('on a realistic protect budget, the residual message lands UNDER protect (no-op cause removed)', () => {
    // protect ~ a real window's 15% (256k → 38400). After spilling, the message
    // must estimate <= protectTokens so the next compaction pass stops no-opping.
    const protectTokens = 38400;
    const big = 'x'.repeat(protectTokens * 8); // ~76800 tokens >> protect
    const { store } = makeStore();
    const res = spillOversizedToolResults({ messages: [toolMsg(big)], protectTokens, store });
    expect(res.spilled).toBe(1);
    expect(msgTokens(res.messages[0])).toBeLessThanOrEqual(protectTokens);
  });

  it('spills a multi-block tool message that is oversized only IN AGGREGATE', () => {
    // Each block is individually under protect, but their SUM exceeds it — the
    // batched-parallel-tool-calls case computeCutoffIndexByTokens trips on.
    const protectTokens = 38400;
    const per = 'y'.repeat(protectTokens); // ~9600 tokens each (text /4), 6× ≈ 57600 > protect
    const { store } = makeStore();
    const msg = toolMsgMulti([per, per, per, per, per, per]);
    expect(msgTokens(msg)).toBeGreaterThan(protectTokens); // precondition: aggregate over
    // sanity: no single block exceeds protect on its own
    for (const b of msg.content) expect(estimateBlockTokens(b)).toBeLessThan(protectTokens);

    const res = spillOversizedToolResults({ messages: [msg], protectTokens, store });

    expect(res.spilled).toBeGreaterThan(0);
    expect(msgTokens(res.messages[0])).toBeLessThanOrEqual(protectTokens);
  });
});
