/**
 * Agent Decision Engine tests (Phase 1).
 *
 * Invariants verified:
 *   - Intent classification routes common asks to the right intent/agent.
 *   - git/admin asks require explicit user intent (no auto-escalation).
 *   - Engine output is pure & deterministic (same input → same output).
 *   - Read-only intents discourage mutating tools.
 *   - Broad read-only asks recommend parallel explore subagents.
 */
import { describe, expect, it } from 'vitest';
import { classifyIntent } from '../task-intent.js';
import {
  decide,
  decisionGuidance,
  decisionGuidanceForTask,
  decisionTelemetryForTask,
  intentProfile,
  toolPolicyForTask,
} from '../decision-engine.js';

describe('classifyIntent', () => {
  const cases: Array<[string, string]> = [
    ['where is the auth flow defined?', 'locate'],
    ['explain how the tool selection pipeline works', 'answer'],
    ['o que faz o decision engine?', 'answer'],
    ['implement a fix for the null pointer bug', 'edit'],
    ['refatore o classificador de intenção', 'edit'],
    ['arrume o fluxo de goals', 'edit'],
    ['conserte o erro de streaming', 'edit'],
    ['ajuste e melhore a orquestração', 'edit'],
    ['aprimore a retomada do agente', 'edit'],
    ['plan a refactor of the runner', 'plan'],
    ['run the tests for code-agent', 'verify'],
    ['npm run build', 'verify'],
    ['commit the fix and push', 'git_admin'],
    ['create a c4 diagram of the architecture', 'diagram'],
    ['update the openapi spec for /users', 'api_collection'],
    ['the component layout looks broken in the preview', 'preview'],
    ['read the docs for the vitest library', 'external_docs'],
  ];
  for (const [msg, expected] of cases) {
    it(`classifies "${msg}" → ${expected}`, () => {
      expect(classifyIntent(msg).intent).toBe(expected);
    });
  }

  it('falls back to low-confidence answer on empty input', () => {
    const r = classifyIntent('   ');
    expect(r.intent).toBe('answer');
    expect(r.confidence).toBeLessThan(0.3);
  });

  it('prioritises git_admin over edit ("fix" + "commit")', () => {
    // "fix" would match edit, but git_admin is checked first.
    expect(classifyIntent('fix the bug then commit it').intent).toBe('git_admin');
  });

  it('keeps "build the feature" as edit, not verify', () => {
    expect(classifyIntent('build the feature for exporting CSV').intent).toBe('edit');
  });
});

describe('decide', () => {
  it('routes a read-only question to explore with read budget', () => {
    const d = decide('explain how compaction works');
    expect(d.recommendedAgent).toBe('explore');
    expect(d.riskBudget).toBe('read');
    expect(d.requiresExplicitUserIntent).toBe(false);
    expect(d.toolPolicy.discouraged).toContain('edit_file');
  });

  it('routes an implement ask to build with write budget', () => {
    const d = decide('implement the new endpoint handler');
    expect(d.recommendedAgent).toBe('build');
    expect(d.riskBudget).toBe('write');
  });

  it('routes live-preview UI work to the dedicated builder agent', () => {
    const d = decide('the component layout looks broken in the preview');
    expect(d.recommendedAgent).toBe('builder');
    expect(d.riskBudget).toBe('write');
  });

  it('routes external documentation research to the read-only research agent', () => {
    const d = decide('read the docs for the vitest library');
    expect(d.recommendedAgent).toBe('research');
    expect(d.riskBudget).toBe('read');
  });

  it('routes a planning ask to plan mode (read ceiling pre-approval)', () => {
    const d = decide('plan the migration strategy');
    expect(d.recommendedAgent).toBe('plan');
    expect(d.phase).toBe('planning');
    expect(d.riskBudget).toBe('read');
  });

  it('flags git/admin work as requiring explicit user intent', () => {
    const d = decide('commit and push the changes');
    expect(d.recommendedAgent).toBe('admin');
    expect(d.riskBudget).toBe('admin');
    expect(d.requiresExplicitUserIntent).toBe(true);
  });

  it('recommends parallel explore for a broad multi-area investigation', () => {
    const broad =
      'find where authentication is handled and also map the database schema and ' +
      'explain how the websocket layer connects to the orchestrator plus the billing flow';
    const d = decide(broad);
    expect(d.delegation).toBe('spawn_explore');
  });

  it('keeps a short read-only ask inline', () => {
    expect(decide('where is the runner defined?').delegation).toBe('inline');
  });

  it('is deterministic — same input yields identical output', () => {
    const a = decide('refactor the tool selection scorer');
    const b = decide('refactor the tool selection scorer');
    expect(a).toEqual(b);
  });

  it('exposes the same routing table via intentProfile', () => {
    expect(intentProfile('git_admin').requiresExplicitUserIntent).toBe(true);
    expect(intentProfile('answer').agent).toBe('explore');
  });
});

describe('decision guidance bridge', () => {
  it('returns compact prompt guidance with capped tool hints', () => {
    const g = decisionGuidanceForTask('implement the new endpoint handler', { currentAgent: 'plan' });
    expect(g.intent).toBe('edit');
    expect(g.recommendedAgent).toBe('build');
    expect(g.currentAgent).toBe('plan');
    expect(g.riskBudget).toBe('write');
    expect(g.confidenceBand).toBe('medium');
    expect(g.agentMismatch).toBe(true);
    expect(g.shouldAskBeforeAgentSwitch).toBe(true);
    expect(g.agentSwitchReason).toContain('build');
    expect(g.preferredTools).toEqual([
      'mcp__get_symbol_body',
      'mcp__prepare_edit',
      'edit_file',
      'multi_edit',
    ]);
    expect(g.discouragedTools).toEqual(['git_commit', 'git_push', 'mcp__index_project']);
    expect(g.reminder).toContain('agent_decision: intent=edit');
    expect(g.reminder).toContain('ask-switch=plan→build');
  });

  it('keeps low-confidence triage conservative and does not ask to switch', () => {
    const g = decisionGuidanceForTask('zzzphlnt qwwx', { currentAgent: 'build' });
    expect(g.phase).toBe('triage');
    expect(g.confidenceBand).toBe('low');
    expect(g.agentMismatch).toBe(false);
    expect(g.shouldAskBeforeAgentSwitch).toBe(false);
    expect(g.reminder).not.toContain('ask-switch=');
  });

  it('preserves specialized preview routing to builder', () => {
    const g = decisionGuidanceForTask('the component layout looks broken in the preview', { currentAgent: 'build' });
    expect(g.intent).toBe('preview');
    expect(g.recommendedAgent).toBe('builder');
    expect(g.shouldAskBeforeAgentSwitch).toBe(true);
    expect(g.reminder).toContain('agent=builder');
  });

  it('marks explicit admin intent and allows asking before switching to admin', () => {
    const g = decisionGuidanceForTask('commit and push the changes', { currentAgent: 'build' });
    expect(g.intent).toBe('git_admin');
    expect(g.recommendedAgent).toBe('admin');
    expect(g.riskBudget).toBe('admin');
    expect(g.requiresExplicitUserIntent).toBe(true);
    expect(g.shouldAskBeforeAgentSwitch).toBe(true);
    expect(g.reminder).toContain('explicit-user-intent-required');
  });

  it('does not ask to switch to admin without explicit user intent', () => {
    const d = decide('implement the new endpoint handler');
    const unsafeAdmin = {
      ...d,
      recommendedAgent: 'admin' as const,
      riskBudget: 'admin' as const,
      requiresExplicitUserIntent: false,
      confidence: 0.9,
    };
    const g = decisionGuidance(unsafeAdmin, { currentAgent: 'build' });
    expect(g.recommendedAgent).toBe('admin');
    expect(g.shouldAskBeforeAgentSwitch).toBe(false);
    expect(g.reminder).not.toContain('ask-switch=');
  });

  it('is deterministic', () => {
    expect(decisionGuidanceForTask('refactor the scorer', { currentAgent: 'plan' })).toEqual(
      decisionGuidanceForTask('refactor the scorer', { currentAgent: 'plan' }),
    );
  });
});

describe('decision telemetry bridge', () => {
  it('returns compact telemetry without long tool arrays or rationale', () => {
    const t = decisionTelemetryForTask('implement the new endpoint handler');
    expect(t.intent).toBe('edit');
    expect(t.recommendedAgent).toBe('build');
    expect(t.phase).toBe('editing');
    expect(t.toolPolicyPreferredCount).toBeGreaterThan(0);
    expect(t.toolPolicyDiscouragedCount).toBeGreaterThan(0);
    expect('toolPolicy' in t).toBe(false);
    expect('rationale' in t).toBe(false);
  });

  it('still records low-confidence triage telemetry', () => {
    const t = decisionTelemetryForTask('zzzphlnt qwwx');
    expect(t.phase).toBe('triage');
    expect(t.confidence).toBeLessThan(0.3);
  });
});

describe('toolPolicyForTask (tool-selection bridge)', () => {
  it('returns preferred/discouraged hints for a confidently classified edit task', () => {
    const p = toolPolicyForTask('implement the new endpoint handler');
    expect(p).toBeDefined();
    expect(p!.preferred.length).toBeGreaterThan(0);
    expect(p!.discouraged).toContain('git_commit');
  });

  it('produces git tool hints for an explicit git/admin task', () => {
    const p = toolPolicyForTask('commit and push the changes');
    expect(p).toBeDefined();
    expect(p!.preferred).toContain('git_commit');
  });

  it('returns undefined for an unrecognized/low-confidence message (no nudge)', () => {
    expect(toolPolicyForTask('zzzphlnt qwwx')).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(toolPolicyForTask('   ')).toBeUndefined();
  });

  it('is deterministic', () => {
    expect(toolPolicyForTask('refactor the scorer')).toEqual(
      toolPolicyForTask('refactor the scorer'),
    );
  });
});
