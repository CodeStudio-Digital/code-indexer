/**
 * Unit tests for the failure-streak guard (PR 5).
 *
 * Contract:
 *   - isError=false → state cleared, return `pass`.
 *   - isError=true on non-exempt tool → increment, return verdict
 *     based on thresholds (`pass` → `reminder` → `refuse`).
 *   - REPEATABLE_NAME_PATTERN tools (mcp__list_*, await_*, *_status, …)
 *     are exempt — failure chain is the workflow there.
 *   - Independent counters per tool name.
 *   - lastError snippet truncated to 200 chars.
 *   - Threshold overrides honored.
 */
import { describe, it, expect } from 'vitest';
import {
  checkFailureStreak,
  buildFailureStreakReminderMarker,
  buildFailureStreakRefusalText,
  emptyFailureStreakState,
  isFailureStreakExempt,
  parseErrorSignal,
} from '../failure-streak.js';

describe('checkFailureStreak — happy path', () => {
  it('returns pass and clears state on a successful call', () => {
    const state = emptyFailureStreakState();
    // Seed a streak of 2 failures.
    checkFailureStreak({ toolName: 'write_stdin', isError: true, errorContent: 'e1', turn: 1, state });
    checkFailureStreak({ toolName: 'write_stdin', isError: true, errorContent: 'e2', turn: 2, state });
    expect(state.streaks.get('write_stdin')?.consecutive).toBe(2);

    const verdict = checkFailureStreak({
      toolName: 'write_stdin', isError: false, errorContent: '', turn: 3, state,
    });
    expect(verdict.kind).toBe('pass');
    expect(state.streaks.has('write_stdin')).toBe(false);
  });

  it('does not register state for the first failure under the reminder threshold', () => {
    const state = emptyFailureStreakState();
    const verdict = checkFailureStreak({
      toolName: 'write_stdin', isError: true, errorContent: 'boom', turn: 1, state,
    });
    expect(verdict.kind).toBe('pass');
    // State IS registered (so the next call can find consecutive=1) but
    // the verdict is still pass since we're under the threshold.
    expect(state.streaks.get('write_stdin')?.consecutive).toBe(1);
  });
});

describe('checkFailureStreak — threshold escalation', () => {
  it('emits reminder at the 3rd consecutive failure (default threshold)', () => {
    const state = emptyFailureStreakState();
    for (let i = 1; i <= 2; i++) {
      const v = checkFailureStreak({
        toolName: 'write_stdin', isError: true,
        errorContent: `failure ${i}`, turn: i, state,
      });
      expect(v.kind).toBe('pass');
    }
    const v3 = checkFailureStreak({
      toolName: 'write_stdin', isError: true,
      errorContent: 'failure 3', turn: 3, state,
    });
    expect(v3.kind).toBe('reminder');
    if (v3.kind === 'reminder') {
      expect(v3.count).toBe(3);
      expect(v3.firstFailureTurn).toBe(1);
      expect(v3.lastError).toBe('failure 3');
    }
  });

  it('emits refuse at the 5th consecutive failure (default threshold)', () => {
    const state = emptyFailureStreakState();
    for (let i = 1; i <= 4; i++) {
      checkFailureStreak({
        toolName: 'write_stdin', isError: true,
        errorContent: `failure ${i}`, turn: i, state,
      });
    }
    const v5 = checkFailureStreak({
      toolName: 'write_stdin', isError: true,
      errorContent: 'failure 5', turn: 5, state,
    });
    expect(v5.kind).toBe('refuse');
    if (v5.kind === 'refuse') {
      expect(v5.count).toBe(5);
      expect(v5.firstFailureTurn).toBe(1);
      expect(v5.lastError).toBe('failure 5');
    }
  });

  it('honours custom thresholds', () => {
    const state = emptyFailureStreakState();
    const v1 = checkFailureStreak({
      toolName: 'edit_file', isError: true, errorContent: 'x', turn: 1, state,
      reminderThreshold: 1, refuseThreshold: 2,
    });
    expect(v1.kind).toBe('reminder');
    const v2 = checkFailureStreak({
      toolName: 'edit_file', isError: true, errorContent: 'y', turn: 2, state,
      reminderThreshold: 1, refuseThreshold: 2,
    });
    expect(v2.kind).toBe('refuse');
  });

  it('keeps refusing while the streak continues past the refuse threshold', () => {
    const state = emptyFailureStreakState();
    for (let i = 1; i <= 5; i++) {
      checkFailureStreak({ toolName: 'edit_file', isError: true, errorContent: 'e', turn: i, state });
    }
    const v6 = checkFailureStreak({
      toolName: 'edit_file', isError: true, errorContent: 'e6', turn: 6, state,
    });
    expect(v6.kind).toBe('refuse');
    if (v6.kind === 'refuse') expect(v6.count).toBe(6);
  });
});

describe('checkFailureStreak — exemptions', () => {
  it.each([
    'mcp__list_directory',
    'list_sessions',
    'await_subagents',
    'wait_for_compile_clean',
    'mcp__poll_index',
    'service_status',
    'session_logs',
    'project_pulse',
    'tail_logs',
    'monitor_health',
  ])('exempts %s (matches REPEATABLE_NAME_PATTERN)', (name) => {
    expect(isFailureStreakExempt(name)).toBe(true);
    const state = emptyFailureStreakState();
    for (let i = 1; i <= 10; i++) {
      const v = checkFailureStreak({
        toolName: name, isError: true, errorContent: 'still polling', turn: i, state,
      });
      expect(v.kind).toBe('pass');
    }
    // State stays empty — exempt tools never register a streak.
    expect(state.streaks.has(name)).toBe(false);
  });

  it('does NOT exempt non-polling names like write_stdin or edit_file', () => {
    expect(isFailureStreakExempt('write_stdin')).toBe(false);
    expect(isFailureStreakExempt('edit_file')).toBe(false);
    expect(isFailureStreakExempt('code_exec')).toBe(false);
  });
});

describe('checkFailureStreak — per-tool isolation', () => {
  it('tracks each tool independently', () => {
    const state = emptyFailureStreakState();
    checkFailureStreak({ toolName: 'A', isError: true, errorContent: 'a1', turn: 1, state });
    checkFailureStreak({ toolName: 'B', isError: true, errorContent: 'b1', turn: 1, state });
    checkFailureStreak({ toolName: 'A', isError: true, errorContent: 'a2', turn: 2, state });
    expect(state.streaks.get('A')?.consecutive).toBe(2);
    expect(state.streaks.get('B')?.consecutive).toBe(1);
  });

  it('A success on tool X does not clear tool Y\'s streak', () => {
    const state = emptyFailureStreakState();
    checkFailureStreak({ toolName: 'X', isError: true, errorContent: 'x', turn: 1, state });
    checkFailureStreak({ toolName: 'Y', isError: true, errorContent: 'y', turn: 1, state });
    checkFailureStreak({ toolName: 'X', isError: false, errorContent: '', turn: 2, state });
    expect(state.streaks.has('X')).toBe(false);
    expect(state.streaks.get('Y')?.consecutive).toBe(1);
  });
});

describe('checkFailureStreak — content snippet', () => {
  it('truncates lastError to 200 chars', () => {
    const state = emptyFailureStreakState();
    const longErr = 'x'.repeat(500);
    checkFailureStreak({
      toolName: 'edit_file', isError: true, errorContent: longErr, turn: 1, state,
    });
    expect(state.streaks.get('edit_file')?.lastError.length).toBe(200);
  });
});

describe('marker / refusal text builders', () => {
  it('reminder marker mentions count, first turn, and tool', () => {
    const text = buildFailureStreakReminderMarker({
      toolName: 'write_stdin', count: 3, firstFailureTurn: 7, lastError: 'oops',
    });
    expect(text).toContain('write_stdin');
    expect(text).toContain('3 times');
    expect(text).toContain('turn 7');
  });

  it('refusal text includes the error excerpt when available', () => {
    const text = buildFailureStreakRefusalText({
      toolName: 'write_stdin', count: 5, firstFailureTurn: 7,
      lastError: 'session not active',
    });
    expect(text).toContain('REFUSED');
    expect(text).toContain('5 times');
    expect(text).toContain('write_stdin');
    expect(text).toContain('session not active');
  });

  it('refusal text gracefully omits the error excerpt when blank', () => {
    const text = buildFailureStreakRefusalText({
      toolName: 'write_stdin', count: 5, firstFailureTurn: 7, lastError: '',
    });
    expect(text).not.toContain('Last error:');
  });
});

describe('parseErrorSignal — classification', () => {
  it('classifies transient network/timeout/rate-limit errors', () => {
    expect(parseErrorSignal('connect ECONNREFUSED 127.0.0.1:5432')).toBe('transient');
    expect(parseErrorSignal('request timed out after 30s')).toBe('transient');
    expect(parseErrorSignal('HTTP 429 rate limited, try again')).toBe('transient');
    expect(parseErrorSignal('upstream returned 503')).toBe('transient');
  });
  it('classifies permanent perms/missing/syntax errors', () => {
    expect(parseErrorSignal("EACCES: permission denied, open '/etc/x'")).toBe('permanent');
    expect(parseErrorSignal('ENOENT: no such file or directory')).toBe('permanent');
    expect(parseErrorSignal('SyntaxError: unexpected token')).toBe('permanent');
    expect(parseErrorSignal('Cannot find module "foo"')).toBe('permanent');
  });
  it('returns unknown when no pattern matches or content is empty', () => {
    expect(parseErrorSignal('the widget exploded')).toBe('unknown');
    expect(parseErrorSignal('')).toBe('unknown');
  });
});

describe('checkFailureStreak — C2-b signal classification', () => {
  it('resets the streak when the error category changes (classifyErrors on)', () => {
    const state = emptyFailureStreakState();
    for (let i = 1; i <= 4; i++) {
      checkFailureStreak({
        toolName: 'http_request', isError: true,
        errorContent: 'ECONNREFUSED', turn: i, state, classifyErrors: true,
      });
    }
    expect(state.streaks.get('http_request')?.consecutive).toBe(4);
    // 5th failure is a DIFFERENT (permanent) cause → reset to 1, not refuse.
    const v = checkFailureStreak({
      toolName: 'http_request', isError: true,
      errorContent: 'EACCES: permission denied', turn: 5, state, classifyErrors: true,
    });
    expect(v.kind).toBe('pass');
    expect(state.streaks.get('http_request')?.consecutive).toBe(1);
    expect(state.streaks.get('http_request')?.signalCategory).toBe('permanent');
  });

  it('still escalates to refuse when the category is stable (classifyErrors on)', () => {
    const state = emptyFailureStreakState();
    let v;
    for (let i = 1; i <= 5; i++) {
      v = checkFailureStreak({
        toolName: 'http_request', isError: true,
        errorContent: 'ETIMEDOUT', turn: i, state, classifyErrors: true,
      });
    }
    expect(v?.kind).toBe('refuse');
  });

  it('does NOT reset on a category change when classifyErrors is off (legacy behavior)', () => {
    const state = emptyFailureStreakState();
    for (let i = 1; i <= 4; i++) {
      checkFailureStreak({ toolName: 'http_request', isError: true, errorContent: 'ECONNREFUSED', turn: i, state });
    }
    const v = checkFailureStreak({
      toolName: 'http_request', isError: true, errorContent: 'EACCES', turn: 5, state,
    });
    expect(v.kind).toBe('refuse');
  });

  it('does not reset on an unknown→concrete transition (avoids false resets)', () => {
    const state = emptyFailureStreakState();
    for (let i = 1; i <= 4; i++) {
      checkFailureStreak({
        toolName: 'edit_file', isError: true, errorContent: 'weird failure', turn: i, state, classifyErrors: true,
      });
    }
    const v = checkFailureStreak({
      toolName: 'edit_file', isError: true, errorContent: 'EACCES', turn: 5, state, classifyErrors: true,
    });
    expect(v.kind).toBe('refuse');
  });
});
