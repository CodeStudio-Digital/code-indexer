import { describe, expect, it } from 'vitest';
import type {
  AgentRunAttemptId,
  AgentRunId,
  SessionId,
} from '@mcp/agent-runtime-contracts';
import {
  RuntimeRouteConflictError,
  RuntimeRouter,
  type RuntimeEligibilityInput,
  type RuntimeRouteCommit,
  type RuntimeRouteRecord,
  type RuntimeRouteRequest,
  type RuntimeRouteStorePort,
} from '../index.js';

const eligibilityInput: RuntimeEligibilityInput = {
  surface: 'coder.interactive',
  platform: 'win32-x64',
  environmentKind: 'worktree',
  provider: 'openai',
  capabilityProfile: 'coder.default',
  capabilityCatalogVersion: 'catalog-v1',
  capabilityIds: ['fs.read', 'patch.apply'],
  engineVersion: 'coder-worker-v1',
  runtimeBuildId: 'coder-worker-v1+build.7',
  runtimeBinarySha256: 'a'.repeat(64),
  protocolVersion: '1.0',
  requiredContainmentLevel: 'monitored',
};

function routeRequest(
  preference: RuntimeRouteRequest['preference'] = 'legacy_required',
): RuntimeRouteRequest {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111' as SessionId,
    agentRunId: '22222222-2222-4222-8222-222222222222' as AgentRunId,
    attemptId: '33333333-3333-4333-8333-333333333333' as AgentRunAttemptId,
    preference,
    cohort: 'internal',
    eligibility: eligibilityInput,
  };
}

class MemoryRouteStore implements RuntimeRouteStorePort {
  readonly records = new Map<string, RuntimeRouteRecord>();
  commitCount = 0;
  committedOverride?: RuntimeRouteRecord;

  async getByAttemptId(
    attemptId: AgentRunAttemptId,
  ): Promise<RuntimeRouteRecord | undefined> {
    return this.records.get(attemptId);
  }

  async commitIfAbsent(candidate: RuntimeRouteRecord): Promise<RuntimeRouteCommit> {
    this.commitCount += 1;
    if (this.committedOverride) {
      return { record: this.committedOverride, inserted: false };
    }
    const existing = this.records.get(candidate.attemptId);
    if (existing) return { record: existing, inserted: false };
    this.records.set(candidate.attemptId, candidate);
    return { record: candidate, inserted: true };
  }
}

function fixedClock() {
  return { now: () => new Date('2026-07-24T12:00:00.000Z') };
}

describe('RuntimeRouter', () => {
  it('commits the complete TypeScript worker route before returning it', async () => {
    const store = new MemoryRouteStore();
    const route = await new RuntimeRouter(store, fixedClock()).route(routeRequest());
    expect(route).toMatchObject({
      runtimeGeneration: 'legacy_ts', selectionReasonCode: 'legacy_required',
      cohort: 'internal', capabilityCatalogVersion: 'catalog-v1',
      engineVersion: 'coder-worker-v1', runtimeBuildId: 'coder-worker-v1+build.7',
      runtimeBinarySha256: 'a'.repeat(64), protocolVersion: '1.0',
      requiredContainmentLevel: 'monitored', selectedAt: '2026-07-24T12:00:00.000Z',
    });
    expect(store.records.get(route.attemptId)).toEqual(route);
    expect(store.commitCount).toBe(1);
  });

  it('reuses an existing immutable route without committing again', async () => {
    const store = new MemoryRouteStore(), router = new RuntimeRouter(store, fixedClock());
    const request = routeRequest(), first = await router.route(request);
    expect(await router.route(request)).toEqual(first);
    expect(await router.getCommittedRoute(request.attemptId)).toEqual(first);
    expect(store.commitCount).toBe(1);
  });

  it('rejects attempt ID reuse with a different provider or worker build', async () => {
    const store = new MemoryRouteStore(), router = new RuntimeRouter(store, fixedClock());
    const request = routeRequest(); await router.route(request);
    for (const changed of [{ provider: 'different-provider' }, { runtimeBinarySha256: 'b'.repeat(64) }]) {
      await expect(router.route({ ...request, eligibility: { ...request.eligibility, ...changed } }))
        .rejects.toBeInstanceOf(RuntimeRouteConflictError);
    }
    expect(store.commitCount).toBe(1);
  });

  it('fails closed when an atomic commit reports a competing route', async () => {
    const store = new MemoryRouteStore(), request = routeRequest();
    store.committedOverride = {
      ...(await new RuntimeRouter(new MemoryRouteStore(), fixedClock()).route(request)),
      provider: 'competing-provider',
    };
    await expect(new RuntimeRouter(store, fixedClock()).route(request)).rejects.toBeInstanceOf(RuntimeRouteConflictError);
  });

  it('rejects invalid inputs and unavailable routes before committing', async () => {
    const store = new MemoryRouteStore(), router = new RuntimeRouter(store, fixedClock());
    const request = routeRequest();
    await expect(router.route({ ...request, preference: 'removed-runtime' as never }))
      .rejects.toMatchObject({ code: 'invalid_routing_request' });
    await expect(router.route({ ...request, eligibility: { ...request.eligibility, runtimeBinarySha256: 'invalid' } }))
      .rejects.toMatchObject({ code: 'invalid_routing_request' });
    await expect(router.getCommittedRoute(request.attemptId)).rejects.toMatchObject({ code: 'runtime_route_not_committed' });
    expect(store.commitCount).toBe(0);
  });

  it('rejects persisted routes from an unsupported runtime', async () => {
    const store = new MemoryRouteStore(), router = new RuntimeRouter(store, fixedClock());
    const request = routeRequest(), route = await router.route(request);
    store.records.set(request.attemptId, { ...route, runtimeGeneration: 'removed-runtime' as never });
    await expect(router.route(request)).rejects.toMatchObject({ code: 'runtime_route_corrupt' });
    await expect(router.getCommittedRoute(request.attemptId)).rejects.toMatchObject({ code: 'runtime_route_corrupt' });
  });
});
