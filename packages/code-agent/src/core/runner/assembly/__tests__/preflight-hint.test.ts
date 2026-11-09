/**
 * renderPreflightHint — pure renderer of the `<preflight>` block.
 * Pinned exactly: the block is hashed for injection dedup, so any change
 * here is intentional (it forces a re-inject on resumed runners).
 */
import { describe, expect, it } from 'vitest';
import { renderPreflightHint } from '../preflight-hint.js';

describe('renderPreflightHint', () => {
  it('renders the full block deterministically', () => {
    const hint = renderPreflightHint({
      profile: 'navigate',
      taskKind: 'bugfix',
      pinTools: ['read_file', 'edit_file'],
      targetProjects: [{ slug: 'poa-intranet-angular', reason: 'task names intranet' }],
      suggestedSkills: [{ id: 'api-collection', reason: 'build the HTTP client', evidence: 'project_scope' }],
      memories: [
        { title: 'Auth token refresh gotcha', reason: 'same login flow' },
        { title: 'API error envelope', reason: '' },
      ],
    });
    expect(hint).toBe([
      '<preflight>',
      'task_kind: bugfix',
      'bug_workflow: reproduce the defect BEFORE touching production code. ' +
        '1) build a reproduction that fails for the expected reason; ' +
        '2) find the root cause with evidence; ' +
        '3) make the smallest fix; ' +
        '4) confirm the reproduction now passes and the previously-passing tests still pass; ' +
        '5) check boundary and negative cases. ' +
        'When a unit test is not viable, a sanitized captured request, fixture, replay, script, browser scenario, integration test or benchmark is an acceptable oracle.',
      'toolset seeded for this task: profile=navigate; prioritized: read_file, edit_file',
      'likely linked projects — verify before editing:',
      '- poa-intranet-angular — task names intranet',
      'skills with objective applicability evidence — confirm the target project before loading:',
      '- api-collection [evidence=project_scope] — build the HTTP client',
      'read these project memories BEFORE exploring (recall_memory({query:"<title>"})):',
      '- "Auth token refresh gotcha" — same login flow',
      '- "API error envelope"',
      'note: these are suggestions from a cheap pre-analysis run before any code was read. Verify against the code; if a memory conflicts with what you observe, trust the code (memories age when files change); find_tools / expand_toolset remain available if something is missing.',
      '</preflight>',
    ].join('\n'));
  });

  it('omits the bug workflow for non-bugfix task kinds', () => {
    const hint = renderPreflightHint({ taskKind: 'feature' });
    expect(hint).toContain('task_kind: feature');
    expect(hint).not.toContain('bug_workflow');
  });

  it('suppresses the bug workflow when the kill switch is off', () => {
    const hint = renderPreflightHint({ taskKind: 'bugfix' }, { bugWorkflow: false });
    expect(hint).toContain('task_kind: bugfix');
    expect(hint).not.toContain('bug_workflow');
  });

  it('memories-only seed omits the toolset and task_kind lines', () => {
    const hint = renderPreflightHint({ memories: [{ title: 'X', reason: 'y' }] });
    expect(hint).not.toContain('toolset seeded');
    expect(hint).not.toContain('task_kind');
    expect(hint).toContain('- "X" — y');
  });

  it('skills-only seed renders the skills nudge and omits memories', () => {
    const hint = renderPreflightHint({ suggestedSkills: [{ id: 'qa-playwright', reason: '' }] });
    expect(hint).toContain('confirm the target project before loading');
    expect(hint).toContain('- qa-playwright');
    expect(hint).not.toContain('recall_memory');
  });

  it('tools-only seed omits the memories and skills blocks', () => {
    const hint = renderPreflightHint({ profile: 'bootstrap', pinTools: ['read_file'] });
    expect(hint).toContain('profile=bootstrap');
    expect(hint).not.toContain('recall_memory');
    expect(hint).not.toContain('get_skill_content');
  });

  it('renders optional Agent Decision guidance inside the preflight block', () => {
    const hint = renderPreflightHint({
      taskKind: 'edit',
      agentDecisionGuidance: {
        recommendedAgent: 'build',
        currentAgent: 'plan',
        intent: 'edit',
        phase: 'editing',
        riskBudget: 'write',
        costBudget: 'medium',
        delegation: 'inline',
        confidence: 0.7,
        confidenceBand: 'medium',
        requiresExplicitUserIntent: false,
        agentMismatch: true,
        shouldAskBeforeAgentSwitch: true,
        agentSwitchReason: 'edit work fits build better than plan.',
        preferredTools: ['mcp__get_symbol_body', 'edit_file'],
        discouragedTools: ['git_commit'],
        reminder: 'agent_decision: intent=edit; agent=build; phase=editing; risk<=write; confidence=medium',
      },
    });

    expect(hint).toContain('<preflight>');
    expect(hint).toContain('agent decision guidance: agent_decision: intent=edit; agent=build');
    expect(hint).toContain('agent switch: ask_user before switching plan → build — edit work fits build better than plan.');
    expect(hint).toContain('</preflight>');
  });
});
