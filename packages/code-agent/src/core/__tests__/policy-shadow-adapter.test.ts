import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAgentRunId,
  asSessionId,
} from '@mcp/session-storage';
import { ToolRegistry } from '../registry.js';
import type { CoderTool } from '../tool.js';
import type { PolicyContext } from '../policy.js';
import { HookBus, type DecisionHookResult } from '../hook-bus.js';
import {
  createPolicyShadowPort,
  type PolicyShadowDeps,
} from '../policy-shadow-adapter.js';
import type {
  PolicyShadowCapabilitySetWrite,
  PolicyShadowComparisonWrite,
  PolicyShadowDecisionWrite,
  PolicyShadowPersistencePort,
} from '../policy-shadow-persistence.js';

const FLAGS = [
  'CODER_POLICY_ENGINE_SHADOW',
  'CODER_CAPABILITY_CATALOG_SHADOW',
  'CODER_HOOK_BUS_V1',
  'CODER_RESOURCE_GRANTS',
  'CODER_POLICY_ENGINE_ENFORCE',
] as const;

let previous: Record<string, string | undefined>;
const SESSION_ID = asSessionId('11111111-1111-4111-8111-111111111111');
const ROOT_RUN_ID = asAgentRunId('22222222-2222-4222-8222-222222222222');
const FOREGROUND_RUN_ID = asAgentRunId('33333333-3333-4333-8333-333333333333');
const BACKGROUND_RUN_ID = asAgentRunId('44444444-4444-4444-8444-444444444444');
const PATH_RUN_ID = asAgentRunId('55555555-5555-4555-8555-555555555555');
const FILTERED_RUN_ID = asAgentRunId('66666666-6666-4666-8666-666666666666');

interface RecordingPersistence extends PolicyShadowPersistencePort {
  decisions: PolicyShadowDecisionWrite[];
  comparisons: PolicyShadowComparisonWrite[];
  capabilitySets: PolicyShadowCapabilitySetWrite[];
}

function recordingPersistence(): RecordingPersistence {
  const persistence: RecordingPersistence = {
    decisions: [],
    comparisons: [],
    capabilitySets: [],
    async recordDecision(input) {
      persistence.decisions.push(input);
    },
    async recordComparison(input) {
      persistence.comparisons.push(input);
    },
    async recordCapabilitySet(input) {
      persistence.capabilitySets.push(input);
    },
  };
  return persistence;
}

let persistence: RecordingPersistence;

function tool(overrides: Partial<CoderTool> & { name: string; source: CoderTool['source'] }): CoderTool {
  return {
    description: 'test tool',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: 'ok' }) as never,
    ...overrides,
  } as CoderTool;
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tool({ name: 'read_file', source: 'native', mutates: false, riskLevel: 'read' }));
  registry.register(tool({ name: 'edit_file', source: 'native', mutates: true, riskLevel: 'write' }));
  return registry;
}

function makeDeps(overrides: Partial<PolicyShadowDeps> = {}, ctx: Partial<PolicyContext> = {}): PolicyShadowDeps {
  return {
    persistence,
    registry: makeRegistry(),
    sessionContext: {
      getLegacyContext: () => ({ planMode: false, planApproved: false, taskScope: null, ...ctx }),
      background: false,
      sessionId: SESSION_ID,
      agentRunId: ROOT_RUN_ID,
    },
    log: () => undefined,
    ...overrides,
  };
}

function invocation(name: string, toolObj: CoderTool | null) {
  return { tool: toolObj, toolUseId: `tu:${name}`, toolName: name, toolInput: {}, turn: 1 };
}

function comparisonCount(): number {
  return persistence.comparisons.length;
}

beforeEach(() => {
  persistence = recordingPersistence();
  previous = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  for (const f of FLAGS) delete process.env[f];
});

afterEach(() => {
  for (const f of FLAGS) {
    if (previous[f] === undefined) delete process.env[f];
    else process.env[f] = previous[f];
  }
});

describe('createPolicyShadowPort', () => {
  it('returns null when every flag is off (port absent = byte-identical path)', () => {
    expect(createPolicyShadowPort(makeDeps())).toBeNull();
  });

  it('shadow on: persists decision + comparison with latency and never refuses', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    const created = createPolicyShadowPort(makeDeps())!;
    const registry = makeRegistry();

    const result = await created.port(invocation('read_file', registry.get('read_file')!));
    expect(result).toEqual({ refuse: false });
    expect(created.metrics.evaluations).toBe(1);
    expect(comparisonCount()).toBe(1);
    const row = persistence.comparisons[0];
    expect(row.shadowEffect).toBe('allow');
    expect(row.legacyEffect).toBe('allow');
    expect(typeof row.evaluationMs).toBe('number');
  });

  it('shadow on: a plan-mode deny still returns refuse:false without ENFORCE', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    const created = createPolicyShadowPort(makeDeps({}, { planMode: true, planApproved: false }))!;
    const registry = makeRegistry();

    const result = await created.port(invocation('edit_file', registry.get('edit_file')!));
    expect(result).toEqual({ refuse: false });
    expect(persistence.comparisons[0]).toMatchObject({
      shadowEffect: 'deny',
      legacyEffect: 'block',
    });
  });

  it('ENFORCE on: refuses a shadow deny with a structured refusal', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    process.env.CODER_POLICY_ENGINE_ENFORCE = '1';
    const created = createPolicyShadowPort(makeDeps({}, { planMode: true, planApproved: false }))!;
    const registry = makeRegistry();

    const denied = await created.port(invocation('edit_file', registry.get('edit_file')!));
    expect(denied).toMatchObject({ refuse: true });
    expect((denied as { refusalText: string }).refusalText).toContain('policy-engine: deny — plan_mode');
    expect(created.metrics.refusals).toBe(1);

    const allowed = await created.port(invocation('read_file', registry.get('read_file')!));
    expect(allowed).toEqual({ refuse: false });
  });

  it('kill switch: flipping the flag off mid-run stops evaluations and persistence', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    const created = createPolicyShadowPort(makeDeps())!;
    const registry = makeRegistry();

    await created.port(invocation('read_file', registry.get('read_file')!));
    expect(comparisonCount()).toBe(1);

    delete process.env.CODER_POLICY_ENGINE_SHADOW;
    const after = await created.port(invocation('read_file', registry.get('read_file')!));
    expect(after).toEqual({ refuse: false });
    expect(created.metrics.evaluations).toBe(1); // unchanged
    expect(comparisonCount()).toBe(1); // no new rows
  });

  it('an internal error is contained: counted, refuse:false, run unaffected', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    const created = createPolicyShadowPort(makeDeps())!;
    // A broken tool (no source) makes deriveCapabilityDescriptor throw.
    const broken = { name: 'broken' } as unknown as CoderTool;

    const result = await created.port(invocation('broken', broken));
    expect(result).toEqual({ refuse: false });
    expect(created.metrics.errors).toBe(1);
    expect(comparisonCount()).toBe(0);
  });

  it('contains a filesystem persistence error without dual-writing elsewhere', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    persistence.recordDecision = async () => {
      throw new Error('bundle unavailable');
    };
    const created = createPolicyShadowPort(makeDeps())!;
    const registry = makeRegistry();

    await expect(
      created.port(invocation('read_file', registry.get('read_file')!)),
    ).resolves.toEqual({ refuse: false });
    expect(created.metrics.evaluations).toBe(1);
    expect(created.metrics.errors).toBe(1);
    expect(persistence.decisions).toHaveLength(0);
    expect(persistence.comparisons).toHaveLength(0);
  });

  it('fails closed opaquely on an internal evaluation error only in ENFORCE', async () => {
    process.env.CODER_POLICY_ENGINE_ENFORCE = '1';
    const created = createPolicyShadowPort(makeDeps())!;
    const broken = { name: 'broken' } as unknown as CoderTool;

    const result = await created.port(invocation('broken', broken));

    expect(result).toEqual({
      refuse: true,
      refusalText: '[policy-engine: unavailable — evaluation_error] Tool execution blocked by fail-closed enforcement.',
    });
    expect(created.metrics.errors).toBe(1);
    expect(created.metrics.refusals).toBe(1);
  });

  it('catalog flag: records the resolved capability set once per run', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    process.env.CODER_CAPABILITY_CATALOG_SHADOW = '1';
    const created = createPolicyShadowPort(makeDeps())!;
    const registry = makeRegistry();

    await created.port(invocation('read_file', registry.get('read_file')!));
    await created.port(invocation('edit_file', registry.get('edit_file')!));

    expect(persistence.capabilitySets).toHaveLength(1);
    expect(persistence.capabilitySets[0].descriptors).toHaveLength(2);
  });

  it('scopes the same authority to child foreground/background mode and task paths', async () => {
    process.env.CODER_HOOK_BUS_V1 = '1';
    process.env.CODER_POLICY_ENGINE_ENFORCE = '1';
    const bus = new HookBus();
    bus.register({
      hookId: 'shared-authority-ask',
      version: '1',
      kind: 'decision',
      stage: 'policy_decision',
      source: 'organization',
      trustLevel: 'trusted_process',
      timeoutMs: 1_000,
      priority: 0,
      failurePolicy: 'closed',
      idempotency: 'none',
      redactionPolicyRef: 'test',
      handler: (): DecisionHookResult => ({
        outcome: 'ask',
        reasonCode: 'approval_required',
      }),
    });
    const created = createPolicyShadowPort(makeDeps({ hookBus: bus }))!;
    const registry = makeRegistry();
    const foreground = created.createScopedPort({
      getLegacyContext: () => ({
        planMode: false,
        planApproved: false,
        taskScope: null,
      }),
      background: false,
      sessionId: SESSION_ID,
      agentRunId: FOREGROUND_RUN_ID,
    });
    const background = created.createScopedPort({
      getLegacyContext: () => ({
        planMode: false,
        planApproved: false,
        taskScope: null,
      }),
      background: true,
      sessionId: SESSION_ID,
      agentRunId: BACKGROUND_RUN_ID,
    });

    expect(await foreground(invocation('edit_file', registry.get('edit_file')!)))
      .toMatchObject({ refuse: true });
    expect(await background(invocation('edit_file', registry.get('edit_file')!)))
      .toMatchObject({ refuse: true });

    expect(persistence.decisions.slice(-2).map((row) => ({
      background: row.background,
      effect: row.decision.effect,
      reasonCode: row.decision.reasonCode,
    }))).toEqual([
      { background: false, effect: 'ask', reasonCode: 'approval_required' },
      { background: true, effect: 'deny', reasonCode: 'background_ask_denied' },
    ]);

    const pathScoped = created.createScopedPort({
      getLegacyContext: () => ({
        planMode: true,
        planApproved: false,
        taskScope: { id: 'child-scope', files: ['allowed.ts'] },
      }),
      background: false,
      sessionId: SESSION_ID,
      agentRunId: PATH_RUN_ID,
    });
    const outside = invocation('edit_file', registry.get('edit_file')!);
    outside.toolInput = { path: 'outside.ts' };
    const refused = await pathScoped(outside);
    expect(refused).toMatchObject({ refuse: true });
    expect((refused as { refusalText: string }).refusalText).toContain('plan_mode');
  });

  it('records a scoped child capability set from its filtered registry, not the root surface', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    process.env.CODER_CAPABILITY_CATALOG_SHADOW = '1';
    const created = createPolicyShadowPort(makeDeps())!;
    const rootRegistry = makeRegistry();
    const childRegistry = new ToolRegistry();
    childRegistry.register(rootRegistry.get('read_file')!);
    const child = created.createScopedPort({
      getLegacyContext: () => ({
        planMode: false,
        planApproved: false,
        taskScope: null,
      }),
      background: false,
      sessionId: SESSION_ID,
      agentRunId: FILTERED_RUN_ID,
      capabilityRegistry: childRegistry,
    });

    await child(invocation('read_file', childRegistry.get('read_file')!));

    const set = persistence.capabilitySets.find(
      (row) => row.agentRunId === FILTERED_RUN_ID,
    )?.set;
    if (!set) throw new Error('filtered child capability set was not recorded');
    expect(set.registered).toEqual(['cap:native:read_file']);
    expect(set.registered).not.toContain('cap:native:edit_file');
  });

  it('does not execute original mutating input when a hook requires patched-input reevaluation', async () => {
    process.env.CODER_HOOK_BUS_V1 = '1';
    process.env.CODER_POLICY_ENGINE_ENFORCE = '1';
    const bus = new HookBus();
    bus.register({
      hookId: 'rewrite-path',
      version: '1',
      kind: 'decision',
      stage: 'policy_decision',
      source: 'organization',
      trustLevel: 'trusted_process',
      timeoutMs: 1_000,
      priority: 0,
      failurePolicy: 'closed',
      idempotency: 'none',
      redactionPolicyRef: 'test',
      handler: (): DecisionHookResult => ({
        outcome: 'allow',
        inputPatch: [{ op: 'replace', path: '/path', value: 'approved.ts' }],
      }),
    });
    let sideEffects = 0;
    const mutating = tool({
      name: 'edit_file',
      source: 'native',
      mutates: true,
      riskLevel: 'write',
      handler: async () => {
        sideEffects += 1;
        return { content: 'changed' };
      },
    });
    const registry = makeRegistry();
    const created = createPolicyShadowPort(makeDeps({ hookBus: bus }))!;
    const result = await created.port({
      ...invocation('edit_file', mutating),
      toolInput: { path: 'original.ts' },
    });
    if (!result.refuse) await mutating.handler({ path: 'original.ts' }, {} as never);

    expect(result).toEqual({
      refuse: true,
      refusalText: '[policy-engine: unavailable — input_reevaluation_required] Tool execution blocked until the validated hook patch can be rebound.',
    });
    expect(sideEffects).toBe(0);
    expect(registry.get('edit_file')).toBeDefined();
  });

  it('fails closed when resource grants are enabled without a bound grant id/nonce', async () => {
    process.env.CODER_RESOURCE_GRANTS = '1';
    process.env.CODER_POLICY_ENGINE_ENFORCE = '1';
    const registry = makeRegistry();
    const created = createPolicyShadowPort(makeDeps())!;

    const result = await created.port(invocation('edit_file', registry.get('edit_file')!));

    expect(result).toEqual({
      refuse: true,
      refusalText: '[policy-engine: unavailable — resource_grant_binding_required] Tool execution blocked by fail-closed enforcement.',
    });
  });

  it('fails closed when hook constraints lack a sealed resource binding', async () => {
    process.env.CODER_HOOK_BUS_V1 = '1';
    process.env.CODER_POLICY_ENGINE_ENFORCE = '1';
    const bus = new HookBus();
    bus.register({
      hookId: 'constrain-path',
      version: '1',
      kind: 'decision',
      stage: 'policy_decision',
      source: 'organization',
      trustLevel: 'trusted_process',
      timeoutMs: 1_000,
      priority: 0,
      failurePolicy: 'closed',
      idempotency: 'none',
      redactionPolicyRef: 'test',
      handler: (): DecisionHookResult => ({
        outcome: 'allow',
        constraints: [{
          kind: 'path',
          root: 'approved',
          access: 'write',
          followSymlinks: false,
        }],
      }),
    });
    const registry = makeRegistry();
    const created = createPolicyShadowPort(makeDeps({ hookBus: bus }))!;

    const result = await created.port(invocation('edit_file', registry.get('edit_file')!));

    expect(result).toEqual({
      refuse: true,
      refusalText: '[policy-engine: unavailable — resource_binding_required] Tool execution blocked until policy constraints are sealed into an execution binding.',
    });
  });
});
