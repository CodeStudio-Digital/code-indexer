/**
 * Unit tests for `recedeToPreserveLastNTurns` — focused on the `maxTailTokens`
 * clamp that stops a single long user turn from defeating compaction.
 *
 * Sizes are derived from the real `estimateMessageTokens` so the assertions
 * hold regardless of the tokenizer's exact constant.
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { estimateMessageTokens } from '@mcp/code-agent/core/token-accounting.js';
import {
  recedeToPreserveLastNTurns,
  recedeToPreserveLastNRenderableTurns,
} from '../cutoff.js';

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function toolMsg(id: string, text: string): AgentMessage {
  return { role: 'tool', content: [{ type: 'tool_result', tool_use_id: id, content: text }] };
}
function tailTokens(messages: AgentMessage[], from: number): number {
  let t = 0;
  for (let i = from; i < messages.length; i++) t += estimateMessageTokens(messages[i]);
  return t;
}
function renderableInTail(messages: AgentMessage[], from: number): number {
  let c = 0;
  for (let i = from; i < messages.length; i++) if (messages[i].role !== 'tool') c++;
  return c;
}

describe('recedeToPreserveLastNTurns', () => {
  it('returns 0 for a single-user-turn history WITHOUT a budget (the legacy no-op cause)', () => {
    // One user message + many tool/assistant turns → < N(=2) user messages.
    const msgs: AgentMessage[] = [user('the big task')];
    for (let i = 0; i < 12; i++) msgs.push(assistant(`work step ${i}`));
    // recede nukes a perfectly good token cutoff to 0 → caller no-ops.
    expect(recedeToPreserveLastNTurns(msgs, 9, 2)).toBe(0);
  });

  it('returns a positive, budget-bounded cutoff for a single long turn WITH a budget', () => {
    const msgs: AgentMessage[] = [user('the big task')];
    for (let i = 0; i < 12; i++) msgs.push(assistant(`work step ${i} ${'x'.repeat(40)}`));
    const cutoff = 9;
    const budget = tailTokens(msgs, cutoff) + estimateMessageTokens(msgs[8]) * 2;
    const r = recedeToPreserveLastNTurns(msgs, cutoff, 2, budget);
    // The fix: a compactable head ALWAYS remains (never 0)...
    expect(r).toBeGreaterThan(0);
    // ...and the preserved tail never exceeds the ceiling.
    expect(tailTokens(msgs, r)).toBeLessThanOrEqual(budget);
  });

  it('preserves the last N user turns when they fit the budget (multi-turn unchanged)', () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 6; i++) { msgs.push(user(`u${i}`)); msgs.push(assistant(`a${i}`)); }
    // cutoff=11 (tail = just a5). Receding to keep 2 user turns lands on u4
    // (index 8) — identically with no budget or a generous one.
    expect(recedeToPreserveLastNTurns(msgs, 11, 2)).toBe(8);
    expect(recedeToPreserveLastNTurns(msgs, 11, 2, 1_000_000)).toBe(8);
  });

  it('is a no-op for the guard cases (n<=0 / cutoff<=0 / cutoff>=len)', () => {
    const msgs = [user('a'), assistant('b')];
    expect(recedeToPreserveLastNTurns(msgs, 1, 0, 100)).toBe(1);
    expect(recedeToPreserveLastNTurns(msgs, 0, 2, 100)).toBe(0);
    expect(recedeToPreserveLastNTurns(msgs, 2, 2, 100)).toBe(2);
  });
});

describe('recedeToPreserveLastNRenderableTurns (message-count floor)', () => {
  it('counts assistant turns too — recedes to keep N renderable in an autonomous (no-user) run', () => {
    // One user task, then a long autonomous stretch with NO further user turns —
    // the sibling `recedeToPreserveLastNTurns` (user-only) would be defeated here.
    const msgs: AgentMessage[] = [user('the big task')];
    for (let i = 0; i < 19; i++) msgs.push(assistant(`work step ${i}`));
    // cutoff=18 → tail = msgs[18..19] (2 assistant turns; user msg is index 0).
    // Floor n=8 → recede until the tail holds 8 renderable turns.
    const r = recedeToPreserveLastNRenderableTurns(msgs, 18, 8);
    expect(renderableInTail(msgs, r)).toBe(8);
    expect(r).toBe(12);
  });

  it('returns the input cutoff when the tail already has >= N renderable turns', () => {
    const msgs = [assistant('a'), assistant('b'), assistant('c'), assistant('d')];
    // cutoff=1 → tail has 3 renderable; N=2 is already satisfied.
    expect(recedeToPreserveLastNRenderableTurns(msgs, 1, 2)).toBe(1);
  });

  it('does NOT count tool-role messages toward the floor', () => {
    const msgs: AgentMessage[] = [
      assistant('A0'),          // 0
      assistant('t1-use'),      // 1
      toolMsg('t1', 'r1'),      // 2 — tool, not counted
      assistant('A1'),          // 3
      assistant('t2-use'),      // 4
      toolMsg('t2', 'r2'),      // 5 — tool, not counted
      assistant('A2'),          // 6
    ];
    // cutoff=6 → tail = [A2] = 1 renderable. Floor n=3 → recede past the tool
    // rows to gather 3 renderable turns: A2(6), A1+use(4,3)… lands at index 3.
    const r = recedeToPreserveLastNRenderableTurns(msgs, 6, 3);
    expect(renderableInTail(msgs, r)).toBeGreaterThanOrEqual(3);
    expect(r).toBe(3);
  });

  it('stops at the budget ceiling — floor is best-effort, tail never exceeds maxTailTokens', () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) msgs.push(assistant(`step ${i} ${'x'.repeat(40)}`));
    const cutoff = 18; // tail = 2 dense messages
    // Budget allows only ~2 more messages beyond the existing tail — far short
    // of the N=8 floor, so the ceiling must win.
    const budget = tailTokens(msgs, cutoff) + estimateMessageTokens(msgs[17]) * 2;
    const r = recedeToPreserveLastNRenderableTurns(msgs, cutoff, 8, budget);
    expect(r).toBeGreaterThan(0);                       // a compactable head remains
    expect(tailTokens(msgs, r)).toBeLessThanOrEqual(budget); // never blows the ceiling
    expect(renderableInTail(msgs, r)).toBeLessThan(8);  // floor not fully met (dense tail)
  });

  it('recedes freely to satisfy the floor when no budget is set', () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 12; i++) msgs.push(assistant(`a${i}`));
    // cutoff=11 → tail = 1. N larger than history → recede to 0 (keep all).
    expect(recedeToPreserveLastNRenderableTurns(msgs, 11, 50)).toBe(0);
  });

  it('is a no-op for the guard cases (n<=0 / cutoff<=0 / cutoff>=len)', () => {
    const msgs = [user('a'), assistant('b')];
    expect(recedeToPreserveLastNRenderableTurns(msgs, 1, 0, 100)).toBe(1);
    expect(recedeToPreserveLastNRenderableTurns(msgs, 0, 2, 100)).toBe(0);
    expect(recedeToPreserveLastNRenderableTurns(msgs, 2, 2, 100)).toBe(2);
  });
});
