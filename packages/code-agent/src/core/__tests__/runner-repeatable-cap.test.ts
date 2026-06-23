/**
 * Tests for the Phase C repeatable-tool / dup-call reminder subsystem.
 *
 * Three new markers were added to `runner.ts`:
 *   - `buildDupCallReminderMarker` — appended at calls 3-4 of dup-call-cap
 *     before the hard refuse at call 5.
 *   - `buildPollingSoftCapMarker`  — appended when a polling/repeatable
 *     tool crosses the per-name soft cap.
 *   - `buildPollingStuckRefusal`   — replaces tool content when a polling
 *     tool returns byte-identical results N times in a row.
 *
 * Determinism matters: these strings end up inside the assistant
 * transcript, so non-determinism would invalidate the provider's
 * prompt-prefix cache.
 *
 * Runtime integration (when the runner actually injects these) lives
 * inside `CoderRunner.run()` — too coupled to mock in a unit test.
 * The forensic script (`scripts/inspect-session.mjs 763`) is the
 * canonical end-to-end check.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDupCallReminderMarker,
  buildPollingSoftCapMarker,
  buildPollingStuckRefusal,
  canRunSummarizer,
} from '../runner.js';

describe('buildDupCallReminderMarker', () => {
  it('wraps a system-reminder block with concrete count + window + hardCap', () => {
    const out = buildDupCallReminderMarker({
      toolName: 'read_file',
      count: 3,
      window: 20,
      hardCap: 5,
    });
    expect(out.startsWith('\n\n<system-reminder>\n')).toBe(true);
    expect(out.endsWith('</system-reminder>')).toBe(true);
    expect(out).toContain('`read_file`');
    expect(out).toContain('3 times');
    expect(out).toContain('last 20 turns');
    expect(out).toContain('next 2 identical call(s) will be REFUSED');
  });

  it('is deterministic — same args produce byte-identical output', () => {
    const a = buildDupCallReminderMarker({
      toolName: 'edit_file', count: 4, window: 20, hardCap: 5,
    });
    const b = buildDupCallReminderMarker({
      toolName: 'edit_file', count: 4, window: 20, hardCap: 5,
    });
    expect(a).toBe(b);
  });

  it('reports "next 1 identical call" when count is hardCap-1', () => {
    const out = buildDupCallReminderMarker({
      toolName: 'grep', count: 4, window: 20, hardCap: 5,
    });
    expect(out).toContain('next 1 identical call(s) will be REFUSED');
  });
});

describe('buildPollingSoftCapMarker', () => {
  it('mentions polling-tool exemption + soft + hard caps explicitly', () => {
    const out = buildPollingSoftCapMarker({
      toolName: 'list_subordinates',
      count: 20,
      window: 30,
      softCap: 20,
      hardCap: 60,
    });
    expect(out.startsWith('\n\n<system-reminder>\n')).toBe(true);
    expect(out.endsWith('</system-reminder>')).toBe(true);
    expect(out).toContain('polling tool `list_subordinates`');
    expect(out).toContain('20 times');
    expect(out).toContain('last 30 turns');
    expect(out).toContain('soft cap 20');
    expect(out).toContain('hard cap is 60');
    expect(out).toContain('REFUSE');
  });

  it('is deterministic — same args produce byte-identical output', () => {
    const a = buildPollingSoftCapMarker({
      toolName: 'wait_for_clean', count: 25, window: 30, softCap: 20, hardCap: 60,
    });
    const b = buildPollingSoftCapMarker({
      toolName: 'wait_for_clean', count: 25, window: 30, softCap: 20, hardCap: 60,
    });
    expect(a).toBe(b);
  });
});

describe('buildPollingStuckRefusal', () => {
  it('reports tool, consecutive count, and firstTurn', () => {
    const out = buildPollingStuckRefusal({
      toolName: 'list_subordinates',
      count: 10,
      firstTurn: 134,
    });
    expect(out.startsWith('Refused:')).toBe(true);
    expect(out).toContain('`list_subordinates`');
    expect(out).toContain('IDENTICAL result 10 consecutive times');
    expect(out).toContain('first seen turn 134');
    expect(out).toContain('Change strategy');
  });

  it('is deterministic — same args produce byte-identical output', () => {
    const a = buildPollingStuckRefusal({
      toolName: 'tail_logs', count: 15, firstTurn: 50,
    });
    const b = buildPollingStuckRefusal({
      toolName: 'tail_logs', count: 15, firstTurn: 50,
    });
    expect(a).toBe(b);
  });

  it('handles single-digit and triple-digit counts identically in tone', () => {
    const small = buildPollingStuckRefusal({
      toolName: 'poll_status', count: 10, firstTurn: 1,
    });
    const big = buildPollingStuckRefusal({
      toolName: 'poll_status', count: 131, firstTurn: 1,
    });
    expect(small).toContain('10 consecutive times');
    expect(big).toContain('131 consecutive times');
    // Same template, just different number — refusal language identical.
    expect(small.replace(/\b\d+\b/g, '#')).toBe(big.replace(/\b\d+\b/g, '#'));
  });
});

// ─── Phase B — summarizer eligibility ───────────────────────────────

describe('canRunSummarizer', () => {
  const base = { maxRuns: 6, cooldownTurns: 8 };

  it('returns false when maxRuns is 0 or negative (kill switch)', () => {
    expect(canRunSummarizer({ ...base, runCount: 0, lastTurn: -Infinity, currentTurn: 100, maxRuns: 0 })).toBe(false);
    expect(canRunSummarizer({ ...base, runCount: 0, lastTurn: -Infinity, currentTurn: 100, maxRuns: -1 })).toBe(false);
  });

  it('returns false when runCount has reached maxRuns', () => {
    expect(canRunSummarizer({ ...base, runCount: 6, lastTurn: 50, currentTurn: 200 })).toBe(false);
    expect(canRunSummarizer({ ...base, runCount: 7, lastTurn: 50, currentTurn: 200 })).toBe(false);
  });

  it('always allows the FIRST run regardless of currentTurn', () => {
    // No prior runs — cooldown does not apply.
    expect(canRunSummarizer({ ...base, runCount: 0, lastTurn: -Infinity, currentTurn: 1 })).toBe(true);
    expect(canRunSummarizer({ ...base, runCount: 0, lastTurn: -Infinity, currentTurn: 1000 })).toBe(true);
  });

  it('enforces the cooldown between consecutive runs', () => {
    // 7 turns since last run → blocked (need 8)
    expect(canRunSummarizer({ ...base, runCount: 1, lastTurn: 10, currentTurn: 17 })).toBe(false);
    // 8 turns since last run → just allowed
    expect(canRunSummarizer({ ...base, runCount: 1, lastTurn: 10, currentTurn: 18 })).toBe(true);
    // 20 turns since last run → trivially allowed
    expect(canRunSummarizer({ ...base, runCount: 3, lastTurn: 50, currentTurn: 70 })).toBe(true);
  });

  it('cooldown=0 effectively disables the spacing requirement', () => {
    expect(canRunSummarizer({
      runCount: 1, lastTurn: 50, currentTurn: 50, maxRuns: 6, cooldownTurns: 0,
    })).toBe(true);
  });

  it('legacy MAX_RUNS=1 behaviour: matches the old summarizedOnce lock', () => {
    // First run allowed
    expect(canRunSummarizer({ runCount: 0, lastTurn: -Infinity, currentTurn: 5, maxRuns: 1, cooldownTurns: 8 })).toBe(true);
    // Second run blocked — equivalent to the legacy summarizedOnce=true gate
    expect(canRunSummarizer({ runCount: 1, lastTurn: 5, currentTurn: 999, maxRuns: 1, cooldownTurns: 8 })).toBe(false);
  });
});
