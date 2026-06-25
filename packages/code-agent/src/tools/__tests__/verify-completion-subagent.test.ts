/**
 * verify-completion-subagent — pure-helper coverage for A1.
 * The subagent run itself needs a provider; here we pin the parsing +
 * message-shaping logic that decides whether CleanFinish is gated.
 */
import { describe, expect, it } from 'vitest';
import {
  parseVerdictBlock,
  buildVerifyInitialMessage,
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
    expect(msg).toContain('# Test summary\nt');
  });

  it('tells the verifier to run git_diff itself when no diff is provided', () => {
    const msg = buildVerifyInitialMessage({ goal: 'g', diff: '' });
    expect(msg).toContain('run `git_diff` yourself');
    expect(msg).not.toContain('```diff');
  });
});
