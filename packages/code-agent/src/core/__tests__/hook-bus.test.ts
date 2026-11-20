import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  createRuntimeHookBus,
  isValidJsonPatch,
  orderHooks,
  type DecisionHookResult,
  type HookDefinition,
} from '../hook-bus.js';
import { CoderRunner } from '../runner.js';
import { ToolRegistry } from '../registry.js';
import type { ChatDelta } from '../messages.js';
import type { ChatProvider } from '../../providers/adapter.js';
import type { ToolContext } from '../tool.js';

function def(overrides: Partial<HookDefinition> & { hookId: string }): HookDefinition {
  return {
    version: '1',
    kind: 'decision',
    stage: 'policy_decision',
    source: 'project',
    trustLevel: 'isolated_worker',
    timeoutMs: 50,
    priority: 100,
    failurePolicy: 'abstain',
    idempotency: 'none',
    redactionPolicyRef: 'redaction:v1',
    handler: () => undefined,
    ...overrides,
  };
}

describe('orderHooks', () => {
  it('orders by source precedence, then priority, then hook ID', () => {
    const ordered = orderHooks([
      def({ hookId: 'z', source: 'plugin', priority: 1 }),
      def({ hookId: 'a', source: 'system', priority: 100 }),
      def({ hookId: 'b', source: 'system', priority: 100 }),
      def({ hookId: 'c', source: 'project', priority: 5 }),
      def({ hookId: 'd', source: 'system', priority: 1 }),
    ]);
    expect(ordered.map((h) => h.hookId)).toEqual(['d', 'a', 'b', 'c', 'z']);
  });
});

describe('HookBus observation containment', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a thrown observation hook is contained and does not propagate', async () => {
    const bus = new HookBus();
    let sideEffect = 0;
    bus.register(def({
      hookId: 'obs-throws',
      kind: 'observation',
      stage: 'run_started',
      handler: () => { throw new Error('boom'); },
    }));
    bus.register(def({
      hookId: 'obs-ok',
      kind: 'observation',
      stage: 'run_started',
      priority: 200,
      handler: () => { sideEffect += 1; },
    }));

    const result = await bus.fireObservation('run_started', {});
    expect(result.fired).toBe(2);
    expect(result.errors).toBe(1);
    // The surviving observation still ran; the throw never aborted dispatch.
    expect(sideEffect).toBe(1);
  });

  it('clears the timeout timer as soon as a hook resolves', async () => {
    vi.useFakeTimers();
    const bus = new HookBus();
    bus.register(def({
      hookId: 'fast',
      kind: 'observation',
      stage: 'run_started',
      timeoutMs: 60_000,
      handler: () => undefined,
    }));

    await bus.fireObservation('run_started', {});
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('HookBus runtime wiring', () => {
  it('fires run terminal in finally and preserves execution when a run hook fails', async () => {
    const order: string[] = [];
    const bus = new HookBus();
    bus.register(def({
      hookId: 'run-start-failure',
      kind: 'observation',
      stage: 'run_started',
      priority: 1,
      handler: () => { throw new Error('contained'); },
    }));
    bus.register(def({
      hookId: 'run-start',
      kind: 'observation',
      stage: 'run_started',
      handler: () => { order.push('run_started'); },
    }));
    bus.register(def({
      hookId: 'run-terminal',
      kind: 'observation',
      stage: 'run_terminal',
      handler: () => { order.push('run_terminal'); },
    }));
    const provider: ChatProvider = {
      name: 'test',
      model: 'test-model',
      setModel() {},
      async *chat(): AsyncIterable<ChatDelta> {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', stop_reason: 'end_turn' };
      },
    };
    const runner = new CoderRunner({
      provider,
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      toolContext: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      hookBus: bus,
    });

    await expect(runner.run()).resolves.toMatchObject({ reason: 'completed' });
    expect(order).toEqual(['run_started', 'run_terminal']);
  });
});

describe('HookBus decision dispatch', () => {
  it('collects decision votes in order without resolving precedence itself', async () => {
    const bus = new HookBus();
    bus.register(def({
      hookId: 'org-deny',
      source: 'organization',
      handler: (): DecisionHookResult => ({ outcome: 'deny', reasonCode: 'org_forbidden' }),
    }));
    bus.register(def({
      hookId: 'project-allow',
      source: 'project',
      handler: (): DecisionHookResult => ({ outcome: 'allow' }),
    }));

    const result = await bus.fireDecision('policy_decision', {});
    // The bus returns votes in precedence ORDER but does not itself reduce a
    // higher deny — that is the Policy Engine's job.
    expect(result.votes.map((v) => `${v.source}:${v.outcome}`)).toEqual([
      'organization:deny',
      'project:allow',
    ]);
  });

  it('resolves a failing decision hook by its failure policy', async () => {
    const bus = new HookBus();
    bus.register(def({ hookId: 'closed', failurePolicy: 'closed', handler: () => { throw new Error('x'); } }));
    bus.register(def({ hookId: 'open', priority: 200, failurePolicy: 'open', handler: () => { throw new Error('x'); } }));
    bus.register(def({ hookId: 'abstain', priority: 300, failurePolicy: 'abstain', handler: () => { throw new Error('x'); } }));

    const result = await bus.fireDecision('policy_decision', {});
    expect(result.errors).toBe(3);
    expect(result.votes.map((v) => v.outcome)).toEqual(['deny', 'allow', 'abstain']);
  });

  it('queues a valid inputPatch for re-evaluation and drops an invalid one', async () => {
    const bus = new HookBus();
    bus.register(def({
      hookId: 'valid-patch',
      handler: (): DecisionHookResult => ({
        outcome: 'allow',
        inputPatch: [{ op: 'replace', path: '/path', value: 'safe.ts' }],
      }),
    }));
    bus.register(def({
      hookId: 'invalid-patch',
      priority: 200,
      handler: (): DecisionHookResult => ({
        outcome: 'allow',
        inputPatch: [{ op: 'bogus', path: 'no-slash' }] as never,
      }),
    }));

    const result = await bus.fireDecision('policy_decision', {});
    expect(result.requiresReevaluation).toBe(true);
    expect(result.proposedPatches.map((p) => p.hookId)).toEqual(['valid-patch']);
  });
});

describe('isValidJsonPatch', () => {
  it('accepts a well-formed RFC-6902 patch and rejects malformed ones', () => {
    expect(isValidJsonPatch([{ op: 'replace', path: '/a', value: 1 }])).toBe(true);
    expect(isValidJsonPatch([{ op: 'add', path: 'a', value: 1 }])).toBe(false); // no leading slash
    expect(isValidJsonPatch([{ op: 'frobnicate', path: '/a' }])).toBe(false);
    expect(isValidJsonPatch('not-an-array')).toBe(false);
  });
});
