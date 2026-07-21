import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { RunContext } from '../../machine/types.js';
import type { CompactResult } from '../llm-compactor.js';
import { takePrecomputedCompaction, shouldKickPrecompute } from '../precompute.js';

/**
 * Consume-side contract of the background summary precompute (perf W1).
 * The kick side delegates wholesale to `compactWithLLM` (covered by its own
 * suite); what needs proof here is the validation that keeps a stale
 * precompute from ever producing a wrong history: head identity by
 * reference, rebase onto the LIVE tail, and single-use clearing.
 */

const msg = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const summaryMsg = (): AgentMessage => ({ role: 'user', content: [{ type: 'text', text: '[summary]' }] });

function okResult(snapshot: AgentMessage[], cutoff: number): CompactResult {
  return {
    ok: true,
    messages: [summaryMsg(), ...snapshot.slice(cutoff)],
    summary: { version: 3 } as unknown as CompactResult['summary'],
    collapsedFrom: cutoff,
    collapsedTo: 1,
    cutoffApplied: cutoff,
    summaryProviderName: 'aux',
    summaryModel: 'aux-model',
  };
}

function ctxWith(messages: AgentMessage[], pre: { snapshot: AgentMessage[]; result: CompactResult } | null): RunContext {
  const ctx = {
    messages,
    summaryPrecompute: pre
      ? { snapshot: pre.snapshot, startedAt: 0, promise: Promise.resolve(pre.result) }
      : null,
  } as unknown as RunContext;
  return ctx;
}

describe('takePrecomputedCompaction', () => {
  it('rebases the summary onto the LIVE tail — appended messages survive verbatim', async () => {
    const snapshot = [msg('a'), msg('b'), msg('c'), msg('d')];
    // Live history appended two messages since the kick; head untouched.
    const live = [...snapshot, msg('e'), msg('f')];
    const ctx = ctxWith(live, { snapshot, result: okResult(snapshot, 2) });

    const consumed = await takePrecomputedCompaction(ctx);
    expect(consumed).not.toBeNull();
    expect(consumed!.collapsedFrom).toBe(2);
    // [synthetic, c, d, e, f] — the post-kick appends are preserved.
    expect(consumed!.messages).toHaveLength(5);
    expect(consumed!.messages[0]).toEqual(summaryMsg());
    expect(consumed!.messages.slice(1)).toEqual([live[2], live[3], live[4], live[5]]);
    expect(ctx.summaryPrecompute).toBeNull(); // single-use
  });

  it('rejects when the head was rewritten (identity mismatch) and clears the slot', async () => {
    const snapshot = [msg('a'), msg('b'), msg('c'), msg('d')];
    const live = [...snapshot, msg('e')];
    // Simulate a durable rewrite: message 1 replaced by an equal-but-new object.
    live[1] = { ...snapshot[1] };
    const ctx = ctxWith(live, { snapshot, result: okResult(snapshot, 2) });

    expect(await takePrecomputedCompaction(ctx)).toBeNull();
    expect(ctx.summaryPrecompute).toBeNull();
  });

  it('rejects a failed or empty summary', async () => {
    const snapshot = [msg('a'), msg('b'), msg('c')];
    const failed: CompactResult = {
      ok: false,
      messages: snapshot,
      summary: null,
      collapsedFrom: 0,
      collapsedTo: 0,
      cutoffApplied: 0,
    };
    const ctx = ctxWith([...snapshot, msg('d')], { snapshot, result: failed });
    expect(await takePrecomputedCompaction(ctx)).toBeNull();
  });

  it('rejects when the cutoff no longer leaves a live tail', async () => {
    const snapshot = [msg('a'), msg('b')];
    // Live history SHRANK to the cutoff boundary (defensive: never happens on
    // the append-only path, but a splice must not produce an empty history).
    const ctx = ctxWith([snapshot[0], snapshot[1]], { snapshot, result: okResult(snapshot, 2) });
    expect(await takePrecomputedCompaction(ctx)).toBeNull();
  });

  it('is a no-op without a pending precompute', async () => {
    const ctx = ctxWith([msg('a')], null);
    expect(await takePrecomputedCompaction(ctx)).toBeNull();
  });
});

describe('shouldKickPrecompute', () => {
  it('fires within the lead window below the trigger and not before', () => {
    // Default trigger 0.90, lead 0.08 → kick at ≥0.82.
    expect(shouldKickPrecompute(0.75)).toBe(false);
    expect(shouldKickPrecompute(0.83)).toBe(true);
    expect(shouldKickPrecompute(0.95)).toBe(true);
  });

  it('CODER_COMPACT_PRECOMPUTE=0 disables the kick', () => {
    const prev = process.env.CODER_COMPACT_PRECOMPUTE;
    try {
      process.env.CODER_COMPACT_PRECOMPUTE = '0';
      expect(shouldKickPrecompute(0.95)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CODER_COMPACT_PRECOMPUTE;
      else process.env.CODER_COMPACT_PRECOMPUTE = prev;
    }
  });
});
