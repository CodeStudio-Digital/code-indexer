/**
 * Tests for the plan-mode workflow exemption. `execute_tasks` carries
 * `mutates: true` but must reach its handler even when a plan hasn't been
 * approved — the handler itself drives the human-gated plan→build transition
 * (present the plan, wait for approval, switch to build) instead of mutating
 * directly. The exemption is PLAN-only: spec mode stays strict, and direct
 * mutating tools (write_file, edit_file, ...) stay gated.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateSoftAgentDecisionGuardrail,
  evaluateToolInvocation,
  isPlanModeWorkflowTool,
  type PolicyContext,
} from '@mcp/code-agent/core/policy.js';
import type { AgentDecisionGuidance } from '@mcp/code-agent/agents/decision-types.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

function makeTool(overrides: Partial<CoderTool> = {}): CoderTool {
  return {
    name: 'execute_tasks',
    description: 'test',
    source: 'native',
    mutates: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ content: '' }),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    planMode: false,
    planApproved: false,
    specMode: false,
    specApproved: false,
    taskScope: null,
    strict: false,
    adminOverride: true,
    sandboxBound: true,
    ...overrides,
  };
}

function makeGuidance(overrides: Partial<AgentDecisionGuidance> = {}): AgentDecisionGuidance {
  return {
    recommendedAgent: 'explore',
    currentAgent: 'explore',
    intent: 'answer',
    phase: 'exploration',
    riskBudget: 'read',
    costBudget: 'low',
    delegation: 'inline',
    confidence: 0.8,
    confidenceBand: 'high',
    requiresExplicitUserIntent: false,
    agentMismatch: false,
    shouldAskBeforeAgentSwitch: false,
    preferredTools: ['mcp__search'],
    discouragedTools: ['edit_file'],
    reminder: 'agent_decision: intent=answer; risk<=read',
    ...overrides,
  };
}

describe('policy — plan-mode workflow exemption', () => {
  it('classifies execute_tasks as a plan-mode workflow verb', () => {
    expect(isPlanModeWorkflowTool('execute_tasks')).toBe(true);
    expect(isPlanModeWorkflowTool('edit_file')).toBe(false);
    expect(isPlanModeWorkflowTool('write_file')).toBe(false);
  });

  it('lets execute_tasks through in plan mode even before approval', () => {
    const tool = makeTool({ name: 'execute_tasks', mutates: true });
    const decision = evaluateToolInvocation(tool, {}, makeCtx({ planMode: true, planApproved: false }));
    expect(decision.allowed).toBe(true);
  });

  it('still blocks a direct mutating tool in plan mode', () => {
    const tool = makeTool({ name: 'edit_file', mutates: true });
    const decision = evaluateToolInvocation(tool, { path: 'foo.ts' }, makeCtx({ planMode: true, planApproved: false }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('plan_mode');
  });

  it('does NOT exempt execute_tasks in spec mode (spec stays strict)', () => {
    const tool = makeTool({ name: 'execute_tasks', mutates: true });
    const decision = evaluateToolInvocation(tool, {}, makeCtx({ specMode: true, specApproved: false }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('spec_mode');
  });
});

describe('policy — soft AgentDecision guardrail', () => {
  it('is default-off when disabled or guidance is missing', () => {
    const tool = makeTool({ name: 'edit_file', mutates: true, riskLevel: 'write' });
    expect(evaluateSoftAgentDecisionGuardrail(tool, { enabled: false, guidance: makeGuidance() }).allowed).toBe(true);
    expect(evaluateSoftAgentDecisionGuardrail(tool, { enabled: true, guidance: null }).allowed).toBe(true);
  });

  it('does not block low-confidence guidance', () => {
    const tool = makeTool({ name: 'edit_file', mutates: true, riskLevel: 'write' });
    const decision = evaluateSoftAgentDecisionGuardrail(tool, {
      enabled: true,
      guidance: makeGuidance({ confidence: 0.25, confidenceBand: 'low' }),
    });
    expect(decision.allowed).toBe(true);
  });

  it('blocks mutating tools for confident read-only decisions', () => {
    const write = evaluateSoftAgentDecisionGuardrail(
      makeTool({ name: 'edit_file', mutates: true, riskLevel: 'write' }),
      { enabled: true, guidance: makeGuidance() },
    );
    expect(write.allowed).toBe(false);
    if (!write.allowed) expect(write.reason).toBe('read_only_risk_budget');
  });

  it('allows non-mutating execute-risk tools because shell handlers still self-gate', () => {
    const exec = evaluateSoftAgentDecisionGuardrail(
      makeTool({ name: 'run_command', mutates: false, riskLevel: 'execute' }),
      { enabled: true, guidance: makeGuidance() },
    );
    expect(exec.allowed).toBe(true);
  });

  it('blocks admin-risk tools unless the decision budget is admin', () => {
    const blocked = evaluateSoftAgentDecisionGuardrail(
      makeTool({ name: 'git_commit', mutates: true, riskLevel: 'admin' }),
      { enabled: true, guidance: makeGuidance({ riskBudget: 'write', intent: 'edit', phase: 'editing' }) },
    );
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe('admin_escalation');

    const allowed = evaluateSoftAgentDecisionGuardrail(
      makeTool({ name: 'git_commit', mutates: true, riskLevel: 'admin' }),
      { enabled: true, guidance: makeGuidance({ riskBudget: 'admin', intent: 'git_admin', recommendedAgent: 'admin' }) },
    );
    expect(allowed.allowed).toBe(true);
  });
});
