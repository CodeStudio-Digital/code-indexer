import { describe, expect, it } from 'vitest';
import {
  evaluatePolicyShadow,
  type PolicyEvaluationRequest,
  type PolicySourceVote,
} from '../policy-engine.js';
import type { PolicyContext } from '../policy.js';
import type { CoderTool } from '../tool.js';

function tool(overrides: Partial<CoderTool> & { name: string; source: CoderTool['source'] }): CoderTool {
  return {
    description: 'test',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: '' }) as never,
    ...overrides,
  } as CoderTool;
}

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    planMode: false,
    planApproved: false,
    taskScope: null,
    ...overrides,
  };
}

function request(overrides: Partial<PolicyEvaluationRequest> = {}): PolicyEvaluationRequest {
  return {
    tool: tool({ name: 'read_file', source: 'native', mutates: false, riskLevel: 'read' }),
    capabilityId: 'cap:native:read_file',
    capabilityVersion: '1',
    args: {},
    legacyContext: ctx(),
    background: false,
    ...overrides,
  };
}

describe('evaluatePolicyShadow — legacy allow-vs-block equivalence', () => {
  it('agrees on allow for a read tool the legacy gate permits', () => {
    const result = evaluatePolicyShadow(request());
    expect(result.legacyResult.allowed).toBe(true);
    expect(result.decision.effect).toBe('allow');
    expect(result.comparison).toMatchObject({ legacyEffect: 'allow', shadowEffect: 'allow', agreement: true });
  });

  it('agrees on block when the legacy gate denies a mutating tool in plan mode', () => {
    const result = evaluatePolicyShadow(request({
      tool: tool({ name: 'edit_file', source: 'native', mutates: true, riskLevel: 'write' }),
      legacyContext: ctx({ planMode: true, planApproved: false }),
    }));
    expect(result.legacyResult.allowed).toBe(false);
    expect(result.decision.effect).toBe('deny');
    expect(result.decision.reasonCode).toBe('plan_mode');
    expect(result.comparison).toMatchObject({ legacyEffect: 'block', shadowEffect: 'deny', agreement: true });
  });

  it('matrix: direct/nested/MCP/plugin read tools all agree on allow', () => {
    const cases: Array<CoderTool> = [
      tool({ name: 'read_file', source: 'native', mutates: false }),
      tool({ name: 'code_exec', source: 'native', mutates: false }),
      tool({ name: 'mcp__docs__search', source: 'mcp', mutates: false }),
      tool({ name: 'mcp__news__get', source: 'mcp_external', mutates: false }),
    ];
    for (const t of cases) {
      const result = evaluatePolicyShadow(request({ tool: t, capabilityId: `cap:${t.name}` }));
      expect(result.comparison.agreement, t.name).toBe(true);
    }
  });
});

describe('evaluatePolicyShadow — precedence', () => {
  it('an organization deny is irreducible even with a lower-precedence grant allow', () => {
    const votes: PolicySourceVote[] = [
      { sourceType: 'organization', sourceRef: 'org:managed', outcome: 'deny', reasonCode: 'org_forbidden' },
      { sourceType: 'grant', sourceRef: 'grant:1', outcome: 'allow' },
    ];
    const result = evaluatePolicyShadow(request({ extraVotes: votes }));
    expect(result.decision.effect).toBe('deny');
    expect(result.decision.reasonCode).toBe('org_forbidden');
    expect(result.decision.precedence).toBe(2);
  });

  it('a decision hook cannot override a higher session deny', () => {
    const result = evaluatePolicyShadow(request({
      tool: tool({ name: 'edit_file', source: 'native', mutates: true }),
      legacyContext: ctx({ planMode: true, planApproved: false }),
      extraVotes: [{ sourceType: 'hook', sourceRef: 'hook:1', outcome: 'allow' }],
    }));
    expect(result.decision.effect).toBe('deny');
    expect(result.decision.reasonCode).toBe('plan_mode');
  });

  it('a grant allow wins when nothing above denies', () => {
    const result = evaluatePolicyShadow(request({
      extraVotes: [{ sourceType: 'grant', sourceRef: 'grant:1', outcome: 'allow', reasonCode: 'user_granted' }],
    }));
    expect(result.decision.effect).toBe('allow');
  });
});

describe('evaluatePolicyShadow — background ask→deny', () => {
  it('converts an ask into a structured deny in background', () => {
    const votes: PolicySourceVote[] = [{ sourceType: 'project', sourceRef: 'project:1', outcome: 'ask' }];
    const foreground = evaluatePolicyShadow(request({ extraVotes: votes, background: false }));
    expect(foreground.decision.effect).toBe('ask');

    const background = evaluatePolicyShadow(request({ extraVotes: votes, background: true }));
    expect(background.decision.effect).toBe('deny');
    expect(background.decision.reasonCode).toBe('background_ask_denied');
    // The legacy fact-gate (evaluateToolInvocation) ALLOWS this read, but the
    // shadow denies it because a project source asked and background cannot
    // pause. This is a genuine, expected divergence (shadow stricter).
    expect(background.comparison).toMatchObject({
      legacyEffect: 'allow',
      shadowEffect: 'deny',
      agreement: false,
    });
  });
});
