/**
 * PR-3 (R3) — kimi-style tagged-section rendering for CompactionSummaryV2.
 * Verifies the rendered summary uses `<tag>...</tag>` blocks instead of
 * `**Header:**` lines and that the field → tag mapping is stable.
 */
import { describe, it, expect } from 'vitest';
import {
  renderSummaryV2,
  overlayLiveState,
  type CompactionSummaryV2,
} from '@mcp/code-agent/core/summarizer.js';

const sampleSummary: CompactionSummaryV2 = {
  primary_request: 'Fix the login bug in the new flow',
  key_concepts: ['session storage', 'CSRF token'],
  files_and_code: [
    { path: 'src/auth.ts', state: 'modified — added token check' },
    { path: 'src/login.ts', state: 'read for context' },
  ],
  errors_and_fixes: ['401 from /api/login when token missing'],
  problem_solving: 'Confirmed token must be set before redirect',
  all_user_messages: ['fix the login bug', 'use the new token flow'],
  pending_tasks: ['add a test', 'update docs'],
  current_work: 'wiring the token into the request header',
  next_step: 'run the e2e suite',
  active_goal: 'Ship secure login flow (status=in_progress)',
};

describe('renderSummaryV2 — tagged sections', () => {
  it('emits <tag>...</tag> blocks for each present field', () => {
    const out = renderSummaryV2(sampleSummary);
    for (const tag of [
      'active_goal',
      'primary_request',
      'current_focus',
      'environment',
      'active_issues',
      'pending_tasks',
      'problem_solving',
      'user_messages',
    ]) {
      expect(out).toContain(`<${tag}>`);
      expect(out).toContain(`</${tag}>`);
    }
  });

  it('does not emit the legacy `**Header:**` markdown style', () => {
    const out = renderSummaryV2(sampleSummary);
    expect(out).not.toContain('**Active goal:**');
    expect(out).not.toContain('**Primary request:**');
    expect(out).not.toContain('**Pending tasks:**');
  });

  it('omits empty sections so the output is lean', () => {
    const minimal: CompactionSummaryV2 = {
      primary_request: 'Do thing',
      key_concepts: [],
      files_and_code: [],
      errors_and_fixes: [],
      problem_solving: '',
      all_user_messages: [],
      pending_tasks: [],
      current_work: '',
      next_step: '',
    };
    const out = renderSummaryV2(minimal);
    expect(out).toContain('<primary_request>');
    expect(out).not.toContain('<environment>');
    expect(out).not.toContain('<active_issues>');
    expect(out).not.toContain('<pending_tasks>');
    expect(out).not.toContain('<problem_solving>');
    expect(out).not.toContain('<user_messages>');
    expect(out).not.toContain('<current_focus>');
  });

  it('current_focus collapses current_work + next_step into one block', () => {
    const out = renderSummaryV2(sampleSummary);
    const m = out.match(/<current_focus>([\s\S]*?)<\/current_focus>/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('work: wiring the token');
    expect(m![1]).toContain('next: run the e2e suite');
  });

  it('environment collapses key_concepts + files_and_code', () => {
    const out = renderSummaryV2(sampleSummary);
    const m = out.match(/<environment>([\s\S]*?)<\/environment>/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('key concepts: session storage, CSRF token');
    expect(m![1]).toContain('`src/auth.ts`');
    expect(m![1]).toContain('files:');
  });

  it('active_goal appears at the top of the summary body', () => {
    const out = renderSummaryV2(sampleSummary);
    const goalIdx = out.indexOf('<active_goal>');
    const requestIdx = out.indexOf('<primary_request>');
    expect(goalIdx).toBeGreaterThan(0);
    expect(requestIdx).toBeGreaterThan(goalIdx);
  });

  it('still surfaces overlaid live state via overlayLiveState', () => {
    const overlaid = overlayLiveState(
      sampleSummary,
      [
        { content: 'Add the test', activeForm: 'Adding the test', status: 'in_progress' },
      ],
      { text: 'Updated goal', status: 'in_progress' },
    );
    const out = renderSummaryV2(overlaid);
    expect(out).toContain('<active_goal>');
    expect(out).toContain('Updated goal');
    expect(out).toContain('<pending_tasks>');
    expect(out).toContain('Add the test');
  });

  it('renders deterministically — same input → same bytes', () => {
    const a = renderSummaryV2(sampleSummary);
    const b = renderSummaryV2(sampleSummary);
    expect(a).toBe(b);
  });
});
