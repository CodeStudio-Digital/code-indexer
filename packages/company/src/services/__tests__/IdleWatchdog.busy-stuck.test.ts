/**
 * Tests for the Phase 5 "busy but stuck" detection in IdleWatchdog: agents ARE
 * running but produce no SEMANTIC progress (board/kanban/delivery) for a long
 * window — the most common real stall, invisible to the plain idle check.
 */
import { describe, it, expect, vi } from 'vitest';
import { IdleWatchdog, type IdleWatchdogDeps } from '../IdleWatchdog.js';

const T0 = 1_000_000;
const SEMANTIC_MS = 10 * 60 * 1000;

function make(runningCount: number) {
  let nowVal = T0;
  const publish = vi.fn();
  const deps = {
    ctx: { isAborted: false, isBusEnded: false },
    bus: { publish, markEnded: vi.fn() },
    master: { hasEnded: false },
    subordinates: { get runningCount() { return runningCount; } },
    now: () => nowVal,
  } as unknown as IdleWatchdogDeps;
  const wd = new IdleWatchdog(deps);
  const tick = () => (wd as unknown as { tick(): void }).tick();
  return {
    wd, publish, tick,
    advance: (ms: number) => { nowVal += ms; },
    recordSemantic: () => wd.recordActivity('board_entry'),
    recordHeartbeat: () => wd.recordActivity('text_delta'),
  };
}

describe('IdleWatchdog busy-but-stuck', () => {
  it('fires session_stalled(busy_no_progress) when running but no semantic progress', () => {
    const h = make(1);
    h.advance(SEMANTIC_MS + 1000);
    h.tick();
    expect(h.publish).toHaveBeenCalledWith('session_stalled', expect.objectContaining({ reason: 'busy_no_progress' }));
  });

  it('does NOT fire before the semantic threshold', () => {
    const h = make(1);
    h.advance(SEMANTIC_MS - 1000);
    h.tick();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('a heartbeat event does NOT count as progress (still fires)', () => {
    const h = make(1);
    h.advance(SEMANTIC_MS / 2);
    h.recordHeartbeat(); // text_delta — not semantic
    h.advance(SEMANTIC_MS / 2 + 1000);
    h.tick();
    expect(h.publish).toHaveBeenCalledWith('session_stalled', expect.objectContaining({ reason: 'busy_no_progress' }));
  });

  it('a semantic event resets the window (does not fire)', () => {
    const h = make(1);
    h.advance(SEMANTIC_MS + 1000);
    h.recordSemantic(); // board_entry — real progress, resets
    h.tick();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('fires once per stall window (no banner flicker)', () => {
    const h = make(1);
    h.advance(SEMANTIC_MS + 1000);
    h.tick();
    h.tick();
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('is not the busy path when no agents are running', () => {
    const h = make(0);
    h.advance(SEMANTIC_MS + 1000);
    h.tick();
    // With 0 running it falls through to the idle check; that also fires
    // session_stalled but with reason 'no_progress', not 'busy_no_progress'.
    const call = h.publish.mock.calls.find((c) => c[0] === 'session_stalled');
    expect((call?.[1] as { reason?: string })?.reason).toBe('no_progress');
  });
});
