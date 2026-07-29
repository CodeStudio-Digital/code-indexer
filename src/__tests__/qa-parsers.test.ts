import { describe, it, expect } from 'vitest';
import { parseTestPlanSections } from '@mcp/services/qa/parsers/parse-test-plan.js';
import { matchPlanToResults } from '@mcp/services/qa/parsers/match-plan-to-results.js';
import {
  formatRunStatus,
  formatTestStatus,
  summariseRun,
  formatDurationMs,
} from '@mcp/services/qa/parsers/run-status-format.js';
import type { QaTestResult } from '@mcp/services/qa/types.js';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const RESULT_A_ID = '00000000-0000-4000-8000-000000000007';
const RESULT_B_ID = '00000000-0000-4000-8000-000000000009';

// ─── parseTestPlanSections ───────────────────────────────────────

describe('parseTestPlanSections', () => {
  it('extracts sections and bullet scenarios', () => {
    const md = [
      '## Feature: Login',
      '',
      '### Critical flows (P0)',
      '- **Login with valid credentials** — redirects to /dashboard',
      '- Login with wrong password',
      '',
      '### Edge cases (P1)',
      '- Email with leading whitespace',
    ].join('\n');
    const { sections } = parseTestPlanSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('Critical flows (P0)');
    expect(sections[0].priority).toBe('P0');
    expect(sections[0].scenarios.map((s) => s.text)).toEqual([
      'Login with valid credentials redirects to /dashboard',
      'Login with wrong password',
    ]);
    expect(sections[1].priority).toBe('P1');
  });

  it('ignores preamble before first section', () => {
    const md = ['## Feature title', 'Some intro paragraph.', '', '### S (P0)', '- one'].join('\n');
    const { sections } = parseTestPlanSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].scenarios).toHaveLength(1);
  });

  it('captures priority null when no parens in heading', () => {
    const md = ['### Cross-cutting', '- a11y'].join('\n');
    const { sections } = parseTestPlanSections(md);
    expect(sections[0].priority).toBeNull();
  });

  it('attaches specFile via the coverage table', () => {
    const md = [
      '### Critical (P0)',
      '- login valid',
      '',
      '### Coverage (table)',
      '| Scenario | Spec file | Status |',
      '| --- | --- | --- |',
      '| login valid | tests/e2e/login.spec.ts | done |',
    ].join('\n');
    const { sections } = parseTestPlanSections(md);
    expect(sections[0].scenarios[0].specFile).toBe('tests/e2e/login.spec.ts');
  });

  it('accepts both `-` and `*` bullet styles', () => {
    const md = ['### S (P0)', '- one', '* two'].join('\n');
    const { sections } = parseTestPlanSections(md);
    expect(sections[0].scenarios.map((s) => s.text)).toEqual(['one', 'two']);
  });
});

// ─── matchPlanToResults ──────────────────────────────────────────

function mkResult(partial: Partial<QaTestResult> & { test_name: string }): QaTestResult {
  return {
    id: RESULT_A_ID,
    seq: 1,
    run_id: RUN_ID,
    spec_file: 'tests/e2e/x.spec.ts',
    status: 'passed',
    duration_ms: 0,
    error: null,
    trace_path: null,
    screenshot_path: null,
    video_path: null,
    summary_md_path: null,
    kanban_card_id: null,
    created_at: '',
    ...partial,
  };
}

describe('matchPlanToResults', () => {
  it('marks scenarios not-run when no result matches', () => {
    const sections = parseTestPlanSections('### S (P0)\n- login valid').sections;
    const annotated = matchPlanToResults(sections, []);
    expect(annotated[0].scenarios[0].verdict).toBe('not-run');
    expect(annotated[0].scenarios[0].resultId).toBeNull();
  });

  it('matches by exact test name (case-insensitive)', () => {
    const sections = parseTestPlanSections('### S (P0)\n- Login valid').sections;
    const annotated = matchPlanToResults(sections, [
      mkResult({ id: RESULT_A_ID, test_name: 'login valid', status: 'passed' }),
    ]);
    expect(annotated[0].scenarios[0].verdict).toBe('passed');
    expect(annotated[0].scenarios[0].resultId).toBe(RESULT_A_ID);
  });

  it('falls back to substring match', () => {
    const sections = parseTestPlanSections('### S (P0)\n- login flow').sections;
    const annotated = matchPlanToResults(sections, [
      mkResult({ id: RESULT_B_ID, test_name: 'login flow > valid credentials', status: 'failed' }),
    ]);
    expect(annotated[0].scenarios[0].verdict).toBe('failed');
  });

  it('uses the newest result when several match (input order = newest first)', () => {
    const sections = parseTestPlanSections('### S (P0)\n- login').sections;
    const annotated = matchPlanToResults(sections, [
      mkResult({ id: RESULT_B_ID, seq: 2, test_name: 'login', status: 'failed', created_at: '2026-04-25' }),
      mkResult({ id: RESULT_A_ID, seq: 1, test_name: 'login', status: 'passed', created_at: '2026-04-24' }),
    ]);
    expect(annotated[0].scenarios[0].resultId).toBe(RESULT_B_ID);
    expect(annotated[0].scenarios[0].verdict).toBe('failed');
  });
});

// ─── run-status-format ───────────────────────────────────────────

describe('formatRunStatus / formatTestStatus', () => {
  it('returns expected visuals for run statuses', () => {
    expect(formatRunStatus('completed').icon).toBe('✓');
    expect(formatRunStatus('aborted').icon).toBe('⊘');
    expect(formatRunStatus('error').icon).toBe('⚠');
    expect(formatRunStatus('running').icon).toBe('⏳');
  });

  it('returns expected visuals for test statuses', () => {
    expect(formatTestStatus('passed').icon).toBe('✓');
    expect(formatTestStatus('failed').icon).toBe('✗');
    expect(formatTestStatus('skipped').icon).toBe('⊘');
    expect(formatTestStatus('timed-out').icon).toBe('⚠');
    expect(formatTestStatus('interrupted').icon).toBe('⚠');
  });
});

describe('summariseRun', () => {
  it('returns "no tests" when total is zero', () => {
    expect(summariseRun(0, 0, 0)).toBe('no tests');
  });

  it('shortens to passed-only when nothing failed', () => {
    expect(summariseRun(5, 0, 0)).toBe('5/5 passed');
  });

  it('includes failed and skipped detail', () => {
    expect(summariseRun(3, 1, 1)).toBe('3/5 passed (1 failed, 1 skipped)');
    expect(summariseRun(3, 0, 1)).toBe('3/4 passed (1 skipped)');
    expect(summariseRun(3, 1, 0)).toBe('3/4 passed (1 failed)');
  });
});

describe('formatDurationMs', () => {
  it('returns em-dash for null/undefined', () => {
    expect(formatDurationMs(null)).toBe('—');
    expect(formatDurationMs(undefined)).toBe('—');
  });

  it('returns ms below 1s', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(500)).toBe('500ms');
    expect(formatDurationMs(999)).toBe('999ms');
  });

  it('returns seconds between 1s and 1m', () => {
    expect(formatDurationMs(1_000)).toBe('1s');
    expect(formatDurationMs(45_000)).toBe('45s');
    expect(formatDurationMs(59_499)).toBe('59s');
  });

  it('returns minutes and seconds above 1m', () => {
    expect(formatDurationMs(60_000)).toBe('1m 0s');
    expect(formatDurationMs(84_000)).toBe('1m 24s');
    expect(formatDurationMs(125_000)).toBe('2m 5s');
  });
});
