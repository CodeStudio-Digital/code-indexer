/**
 * verify-completion-subagent — pure-helper coverage for A1.
 * The subagent run itself needs a provider; here we pin the parsing +
 * message-shaping logic that decides whether CleanFinish is gated.
 */
import { describe, expect, it } from 'vitest';
import {
  parseVerdictBlock,
  buildVerifyInitialMessage,
  resolveGoalVerificationScope,
  resolveVerifyMaxTurns,
  shouldEnableGoalCompletionVerifier,
} from '@mcp/code-agent/tools/verify-completion-subagent.js';

describe('parseVerdictBlock', () => {
  it('parses goal_met=true with empty gaps', () => {
    const v = parseVerdictBlock('all good\n<verdict>{"goal_met": true, "gaps": []}</verdict>');
    expect(v).toEqual({ goalMet: true, gaps: [] });
  });

  it('parses goal_met=false with gaps and normalizes severity', () => {
    const v = parseVerdictBlock(
      '<verdict>{"goal_met": false, "gaps": [' +
        '{"description": "refresh flow untested", "severity": "high"},' +
        '{"description": "no error envelope", "severity": "bogus"}' +
        ']}</verdict>',
    );
    expect(v?.goalMet).toBe(false);
    expect(v?.gaps).toEqual([
      { description: 'refresh flow untested', severity: 'high' },
      { description: 'no error envelope', severity: 'medium' }, // bad severity → medium
    ]);
  });

  it('returns null when the block is absent (caller treats as NOT met)', () => {
    expect(parseVerdictBlock('I think it is probably fine.')).toBeNull();
  });

  it('returns null on malformed JSON inside the block', () => {
    expect(parseVerdictBlock('<verdict>{goal_met: yes}</verdict>')).toBeNull();
  });

  it('returns null when goal_met is not a boolean', () => {
    expect(parseVerdictBlock('<verdict>{"goal_met": "true", "gaps": []}</verdict>')).toBeNull();
  });

  it('defaults a gap with a missing description and drops non-object entries', () => {
    const v = parseVerdictBlock(
      '<verdict>{"goal_met": false, "gaps": [{"severity": "low"}, "nope", null]}</verdict>',
    );
    expect(v?.gaps).toEqual([{ description: '(no description)', severity: 'low' }]);
  });

  it('is tolerant of case and surrounding whitespace', () => {
    const v = parseVerdictBlock('<VERDICT>\n  {"goal_met": true, "gaps": []}\n</VERDICT>');
    expect(v).toEqual({ goalMet: true, gaps: [] });
  });
});

describe('buildVerifyInitialMessage', () => {
  it('includes goal, plan, tests and diff with sensible fallbacks', () => {
    const msg = buildVerifyInitialMessage({ goal: 'add JWT auth', diff: 'diff --git a b' });
    expect(msg).toContain('# Goal\nadd JWT auth');
    expect(msg).toContain('(no explicit plan was recorded)');
    expect(msg).toContain('(no test run reported)');
    expect(msg).toContain('diff --git a b');
    expect(msg).toContain('<verdict>');
  });

  it('truncates an oversized diff', () => {
    const big = 'x'.repeat(90_000);
    const msg = buildVerifyInitialMessage({ goal: 'g', diff: big, plan: 'p', testSummary: 't' });
    expect(msg).toContain('[diff truncated at 80000 chars');
    expect(msg).toContain('# Plan\np');
    expect(msg).toContain('# Recorded verification evidence\nt');
  });

  it('surfaces stale verification evidence as factual input, not an executor claim', () => {
    const msg = buildVerifyInitialMessage({
      goal: 'g',
      diff: 'diff --git a b',
      testSummary: 'Verification is stale or failed; it does not cover the latest recorded write.',
    });
    expect(msg).toContain('# Recorded verification evidence');
    expect(msg).toContain('does not cover the latest recorded write');
    expect(msg).not.toContain('# Test summary');
  });

  it('keeps no-diff goals verifiable from project state and recorded evidence', () => {
    const msg = buildVerifyInitialMessage({
      goal: 'g',
      diff: '',
      files: ['src/owned.ts', 'test/owned.test.ts'],
    });
    expect(msg).toContain('this may be a no-diff goal');
    expect(msg).toContain('run `git_diff` if pending changes are relevant');
    expect(msg).toContain('# Session-owned file scope');
    expect(msg).toContain('`src/owned.ts`');
    expect(msg).toContain('unrelated concurrent changes');
    expect(msg).not.toContain('```diff');
  });
});

describe('goal completion verifier policy', () => {
  it('is baseline for top-level runs with an explicit kill switch', () => {
    expect(shouldEnableGoalCompletionVerifier(undefined, false)).toBe(true);
    expect(shouldEnableGoalCompletionVerifier('1', false)).toBe(true);
    expect(shouldEnableGoalCompletionVerifier('0', false)).toBe(false);
    expect(shouldEnableGoalCompletionVerifier(undefined, true)).toBe(false);
  });

  it('keeps a substantive persisted goal eligible when no files changed', () => {
    expect(resolveGoalVerificationScope({
      goal: { text: '  Validate the current architecture  ' },
      filesChanged: [],
    })).toEqual({
      goal: 'Validate the current architecture',
      files: [],
    });
  });

  it('does not treat missing or blank goal state as verifiable work', () => {
    expect(resolveGoalVerificationScope(null)).toBeNull();
    expect(resolveGoalVerificationScope({ goal: { text: '   ' }, filesChanged: [] })).toBeNull();
  });

  it('uses a staged create_goal from the current batch before DB persistence', () => {
    expect(resolveGoalVerificationScope(
      { goal: null, filesChanged: ['src/goal.ts'] },
      { text: '  Finish the atomic lifecycle  ' },
    )).toEqual({
      goal: 'Finish the atomic lifecycle',
      files: ['src/goal.ts'],
    });
  });
});

describe('resolveVerifyMaxTurns', () => {
  it('uses a finite baseline outside Ultra and preserves safe explicit overrides', () => {
    expect(resolveVerifyMaxTurns(undefined)).toBe(12);
    expect(resolveVerifyMaxTurns(undefined, 12)).toBe(12);
    expect(resolveVerifyMaxTurns('5', 12)).toBe(5);
    expect(resolveVerifyMaxTurns('0', 12)).toBe(12);
    expect(resolveVerifyMaxTurns('-1', 12)).toBe(12);
    expect(resolveVerifyMaxTurns('invalid', 12)).toBe(12);
    expect(resolveVerifyMaxTurns('999', 12)).toBe(50);
    expect(resolveVerifyMaxTurns(undefined, 0)).toBe(12);
  });
});
