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
  evaluateToolInvocation,
  isPlanModeWorkflowTool,
  type PolicyContext,
} from '@mcp/code-agent/core/policy.js';
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
