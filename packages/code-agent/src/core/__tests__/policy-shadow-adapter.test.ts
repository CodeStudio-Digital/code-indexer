import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { policyEngine255 } from '@mcp/store/migrations/255_policy_engine.js';
import { policyComparisonLatency256 } from '@mcp/store/migrations/256_policy_comparison_latency.js';
import { ToolRegistry } from '../registry.js';
import type { CoderTool } from '../tool.js';
import type { PolicyContext } from '../policy.js';
import { HookBus, type DecisionHookResult } from '../hook-bus.js';
import {
  createPolicyShadowPort,
  type PolicyShadowDeps,
} from '../policy-shadow-adapter.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const FLAGS = [
  'CODER_POLICY_ENGINE_SHADOW',
  'CODER_CAPABILITY_CATALOG_SHADOW',
  'CODER_HOOK_BUS_V1',
  'CODER_RESOURCE_GRANTS',
  'CODER_POLICY_ENGINE_ENFORCE',
] as const;

let db: DB;
let previous: Record<string, string | undefined>;

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
    db,
    registry: makeRegistry(),
    sessionContext: {
      getLegacyContext: () => ({ planMode: false, planApproved: false, taskScope: null, ...ctx }),
      background: false,
      sessionId: 'session:test',
      agentRunId: 'agent-run:test',
    },
    log: () => undefined,
    ...overrides,
  };
}

function invocation(name: string, toolObj: CoderTool | null) {
  return { tool: toolObj, toolUseId: `tu:${name}`, toolName: name, toolInput: {}, turn: 1 };
}

function comparisonCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM policy_decision_comparisons').get() as { count: number }).count;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  policyEngine255.up(db);
  policyComparisonLatency256.up(db);
  previous = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  for (const f of FLAGS) delete process.env[f];
});

afterEach(() => {
  db.close();
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
    const row = db.prepare('SELECT shadow_effect, agreement, evaluation_ms FROM policy_decision_comparisons').get() as {
      shadow_effect: string; agreement: number; evaluation_ms: number | null;
    };
    expect(row.shadow_effect).toBe('allow');
    expect(row.agreement).toBe(1);
    expect(typeof row.evaluation_ms).toBe('number');
  });

  it('shadow on: a plan-mode deny still returns refuse:false without ENFORCE', async () => {
    process.env.CODER_POLICY_ENGINE_SHADOW = '1';
    const created = createPolicyShadowPort(makeDeps({}, { planMode: true, planApproved: false }))!;
    const registry = makeRegistry();

    const result = await created.port(invocation('edit_file', registry.get('edit_file')!));
    expect(result).toEqual({ refuse: false });
    const row = db.prepare('SELECT shadow_effect, legacy_effect, agreement FROM policy_decision_comparisons').get() as {
      shadow_effect: string; legacy_effect: string; agreement: number;
    };
    expect(row).toEqual({ shadow_effect: 'deny', legacy_effect: 'block', agreement: 1 });
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

    const sets = db.prepare('SELECT COUNT(*) AS count FROM resolved_capability_sets').get() as { count: number };
    const descriptors = db.prepare('SELECT COUNT(*) AS count FROM capability_descriptors').get() as { count: number };
    expect(sets.count).toBe(1); // once per run, not per invocation
    expect(descriptors.count).toBe(2);
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
      sessionId: 'session:test:child:fg',
      agentRunId: 'agent-run:child:fg',
    });
    const background = created.createScopedPort({
      getLegacyContext: () => ({
        planMode: false,
        planApproved: false,
        taskScope: null,
      }),
      background: true,
      sessionId: 'session:test:child:bg',
      agentRunId: 'agent-run:child:bg',
    });

    expect(await foreground(invocation('edit_file', registry.get('edit_file')!)))
      .toMatchObject({ refuse: true });
    expect(await background(invocation('edit_file', registry.get('edit_file')!)))
      .toMatchObject({ refuse: true });

    const rows = db.prepare(`
      SELECT background, effect, reason_code
      FROM policy_decisions
      ORDER BY rowid
    `).all() as Array<{ background: number; effect: string; reason_code: string }>;
    expect(rows.slice(-2)).toEqual([
      { background: 0, effect: 'ask', reason_code: 'approval_required' },
      { background: 1, effect: 'deny', reason_code: 'background_ask_denied' },
    ]);

    const pathScoped = created.createScopedPort({
      getLegacyContext: () => ({
        planMode: true,
        planApproved: false,
        taskScope: { id: 'child-scope', files: ['allowed.ts'] },
      }),
      background: false,
      sessionId: 'session:test:child:path',
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
      agentRunId: 'agent-run:filtered-child',
      capabilityRegistry: childRegistry,
    });

    await child(invocation('read_file', childRegistry.get('read_file')!));

    const row = db.prepare(`
      SELECT set_json FROM resolved_capability_sets
      WHERE agent_run_id='agent-run:filtered-child'
    `).get() as { set_json: string };
    const set = JSON.parse(row.set_json) as { registered: string[] };
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
