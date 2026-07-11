import { describe, expect, it } from 'vitest';
import { buildTaskEvidenceIssue } from '../app-build-plan.js';

describe('build task evidence', () => {
  it('requires recorded wireframe red and green cycles', () => {
    const task = { kind: 'test-red', tdd_case_ids: ['wf-login'] };
    expect(buildTaskEvidenceIssue(task, { case_ids: ['wf-login'] }, {})).toContain('record the red');
    expect(buildTaskEvidenceIssue(task, { case_ids: ['wf-login'] }, { 'wf-login': { case_ids: ['wf-login'], script: 'test:e2e', red_at: 'now', green_at: null, last_output: '' } })).toBeNull();
  });

  it('requires explicit visual, responsive, and accessibility proof', () => {
    expect(buildTaskEvidenceIssue({ kind: 'preview', tdd_case_ids: [] }, { preview_url: 'http://localhost', visual_checked: false }, {})).toContain('visual_checked');
    expect(buildTaskEvidenceIssue({ kind: 'responsive', tdd_case_ids: [] }, { files: ['src/App.tsx'] }, {})).toContain('viewports');
    expect(buildTaskEvidenceIssue({ kind: 'accessibility', tdd_case_ids: [] }, { files: ['src/App.tsx'], checks: ['keyboard'] }, {})).toBeNull();
  });
});

