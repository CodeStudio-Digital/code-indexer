import { describe, it, expect } from 'vitest';
import {
  PLAN_GATE_REFUSAL,
  resolvePlanGate,
  roleHasQaPlaywrightSkill,
} from '../qa-plan-gate.js';

const CONFIG = JSON.stringify({
  role_assignments: [
    { role: 'qa', skills: ['qa-playwright', 'docs'] },
    { role: 'frontend', skills: ['docs'] },
    { role: 'backend' },
  ],
});

describe('roleHasQaPlaywrightSkill', () => {
  it('true only for the role carrying qa-playwright', () => {
    expect(roleHasQaPlaywrightSkill(CONFIG, 'qa')).toBe(true);
    expect(roleHasQaPlaywrightSkill(CONFIG, 'frontend')).toBe(false);
    expect(roleHasQaPlaywrightSkill(CONFIG, 'backend')).toBe(false);
    expect(roleHasQaPlaywrightSkill(CONFIG, 'ghost')).toBe(false);
  });

  it('degrades to false on malformed input', () => {
    expect(roleHasQaPlaywrightSkill('', 'qa')).toBe(false);
    expect(roleHasQaPlaywrightSkill('not-json', 'qa')).toBe(false);
    expect(roleHasQaPlaywrightSkill('{}', 'qa')).toBe(false);
    expect(roleHasQaPlaywrightSkill('{"role_assignments":42}', 'qa')).toBe(false);
    expect(roleHasQaPlaywrightSkill(CONFIG, '')).toBe(false);
  });
});

describe('resolvePlanGate', () => {
  it('refuses a QA subordinate without an approved plan (default env)', () => {
    const d = resolvePlanGate({
      requirePlanEnv: undefined,
      isQaSubordinate: true,
      approval: null,
    });
    expect(d).toEqual({ allowed: false, reason: PLAN_GATE_REFUSAL });
    expect(PLAN_GATE_REFUSAL).toContain('submit_plan_to_master');
  });

  it('allows with plan_gate=approved after a manual approval', () => {
    const d = resolvePlanGate({
      requirePlanEnv: undefined,
      isQaSubordinate: true,
      approval: { approved: true, auto: false },
    });
    expect(d).toEqual({ allowed: true, plan_gate: 'approved' });
  });

  it('allows with plan_gate=auto after a fast-path approval', () => {
    const d = resolvePlanGate({
      requirePlanEnv: undefined,
      isQaSubordinate: true,
      approval: { approved: true, auto: true },
    });
    expect(d).toEqual({ allowed: true, plan_gate: 'auto' });
  });

  it("MCP_QA_REQUIRE_PLAN='0' disables the gate → plan_gate=skipped", () => {
    const d = resolvePlanGate({
      requirePlanEnv: '0',
      isQaSubordinate: true,
      approval: null,
    });
    expect(d).toEqual({ allowed: true, plan_gate: 'skipped' });
  });

  it('non-QA callers pass with plan_gate=null (gate does not apply)', () => {
    const d = resolvePlanGate({
      requirePlanEnv: undefined,
      isQaSubordinate: false,
      approval: null,
    });
    expect(d).toEqual({ allowed: true, plan_gate: null });
  });

  it("env '1' (or any non-'0') keeps the gate on", () => {
    const d = resolvePlanGate({
      requirePlanEnv: '1',
      isQaSubordinate: true,
      approval: null,
    });
    expect(d.allowed).toBe(false);
  });
});
