import { describe, expect, it } from 'vitest';
import type {
  AgentRunAttemptId,
  AgentRunId,
  SessionId,
} from '@mcp/agent-runtime-contracts';
import {
  BuildMatrixEligibility,
  RuntimeIneligibleError,
  RuntimeRouteConflictError,
  RuntimeRouter,
  type RuntimeEligibilityDecision,
  type RuntimeEligibilityInput,
  type RuntimeEligibilityPort,
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
  engineVersion: 'agentd-v1',
  runtimeBuildId: 'agentd-v1.0.0+build.7',
  runtimeBinarySha256: 'a'.repeat(64),
  protocolVersion: '1.0',
  requiredContainmentLevel: 'hard_aggregate',
};

function routeRequest(
  preference: RuntimeRouteRequest['preference'] = 'rust_preferred',
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

class MutableEligibility implements RuntimeEligibilityPort {
  calls = 0;

  constructor(
    public decision: RuntimeEligibilityDecision | Error,
  ) {}

  async evaluate(): Promise<RuntimeEligibilityDecision> {
    this.calls += 1;
    if (this.decision instanceof Error) throw this.decision;
    return this.decision;
  }
}

function fixedClock() {
  return { now: () => new Date('2026-07-24T12:00:00.000Z') };
}

describe('BuildMatrixEligibility', () => {
  const matrix = {
    enabled: true,
    build: {
      engineVersion: 'agentd-v1',
      runtimeBuildId: 'agentd-v1.0.0+build.7',
      runtimeBinarySha256: 'a'.repeat(64),
      protocolVersion: '1.0',
    },
    containmentLevels: ['hard_aggregate'],
    surfaces: ['coder.interactive'],
    platforms: ['win32-x64'],
    environmentKinds: ['worktree'],
    providers: ['openai'],
    capabilityProfiles: ['coder.default'],
    capabilityCatalogVersions: ['catalog-v1'],
    capabilityIds: ['fs.read', 'patch.apply'],
  };

  it('admits Rust only when every build dimension is supported', async () => {
    const eligibility = new BuildMatrixEligibility(matrix);

    await expect(eligibility.evaluate(eligibilityInput)).resolves.toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it('denies unsupported provider and capability with typed reasons', async () => {
    const eligibility = new BuildMatrixEligibility(matrix);

    const result = await eligibility.evaluate({
      ...eligibilityInput,
      provider: 'unknown-provider',
      capabilityIds: ['fs.read', 'shell.execute'],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'provider_unsupported',
        requested: 'unknown-provider',
      }),
      expect.objectContaining({
        code: 'capability_unsupported',
        requested: 'shell.execute',
      }),
    ]));
  });

  it('binds eligibility to the exact binary and containment guarantee', async () => {
    const eligibility = new BuildMatrixEligibility(matrix);

    const result = await eligibility.evaluate({
      ...eligibilityInput,
      runtimeBinarySha256: 'b'.repeat(64),
      requiredContainmentLevel: 'hard_process',
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'binary_digest_mismatch' }),
      expect.objectContaining({ code: 'containment_level_unsupported' }),
    ]));
  });

  it('fails closed when the build or a required input dimension is empty', async () => {
    const eligibility = new BuildMatrixEligibility({
      ...matrix,
      enabled: false,
    });

    const result = await eligibility.evaluate({
      ...eligibilityInput,
      surface: '',
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      'rust_disabled',
      'invalid_eligibility_input',
      'surface_unsupported',
    ]));
  });
});

describe('RuntimeRouter', () => {
  it('commits the complete Rust route before returning it', async () => {
    const store = new MemoryRouteStore();
    const eligibility = new MutableEligibility({ eligible: true, reasons: [] });
    const router = new RuntimeRouter(store, eligibility, fixedClock());

    const route = await router.route(routeRequest());

    expect(route).toMatchObject({
      runtimeGeneration: 'rust_v1',
      selectionReasonCode: 'rust_eligible',
      cohort: 'internal',
      capabilityCatalogVersion: 'catalog-v1',
      engineVersion: 'agentd-v1',
      runtimeBuildId: 'agentd-v1.0.0+build.7',
      runtimeBinarySha256: 'a'.repeat(64),
      protocolVersion: '1.0',
      requiredContainmentLevel: 'hard_aggregate',
      selectedAt: '2026-07-24T12:00:00.000Z',
    });
    expect(store.records.get(route.attemptId)).toEqual(route);
    expect(store.commitCount).toBe(1);
  });

  it('reuses an existing route without reevaluating eligibility', async () => {
    const store = new MemoryRouteStore();
    const eligibility = new MutableEligibility({ eligible: true, reasons: [] });
    const router = new RuntimeRouter(store, eligibility, fixedClock());
    const request = routeRequest();
    const first = await router.route(request);
    eligibility.decision = new Error('kill switch changed after launch');

    const second = await router.route(request);

    expect(second).toEqual(first);
    expect(eligibility.calls).toBe(1);
    expect(store.commitCount).toBe(1);
  });

  it('rejects attempt ID reuse with different immutable routing inputs', async () => {
    const store = new MemoryRouteStore();
    const eligibility = new MutableEligibility({ eligible: true, reasons: [] });
    const router = new RuntimeRouter(store, eligibility, fixedClock());
    const request = routeRequest();
    await router.route(request);

    await expect(router.route({
      ...request,
      eligibility: {
        ...request.eligibility,
        provider: 'different-provider',
      },
    })).rejects.toBeInstanceOf(RuntimeRouteConflictError);

    expect(eligibility.calls).toBe(1);
    expect(store.commitCount).toBe(1);
  });

  it('falls back before launch when Rust is preferred and eligibility throws', async () => {
    const store = new MemoryRouteStore();
    const router = new RuntimeRouter(
      store,
      new MutableEligibility(new Error('manifest unavailable')),
      fixedClock(),
    );

    const route = await router.route(routeRequest('rust_preferred'));

    expect(route.runtimeGeneration).toBe('legacy_ts');
    expect(route.selectionReasonCode).toBe('rust_ineligible');
    expect(route.ineligibilityReasons).toEqual([
      expect.objectContaining({
        code: 'eligibility_check_failed',
        detail: 'manifest unavailable',
      }),
    ]);
  });

  it('rejects rust_required without committing a fallback route', async () => {
    const store = new MemoryRouteStore();
    const decision: RuntimeEligibilityDecision = {
      eligible: false,
      reasons: [{ code: 'provider_unsupported', dimension: 'provider' }],
    };
    const router = new RuntimeRouter(
      store,
      new MutableEligibility(decision),
      fixedClock(),
    );

    await expect(router.route(routeRequest('rust_required')))
      .rejects.toBeInstanceOf(RuntimeIneligibleError);
    expect(store.commitCount).toBe(0);
    expect(store.records.size).toBe(0);
  });

  it('treats contradictory eligibility results as an ineligible decision', async () => {
    const store = new MemoryRouteStore();
    const contradictory = {
      eligible: true,
      reasons: [{ code: 'rust_disabled', dimension: 'runtime' }],
    } as RuntimeEligibilityDecision;
    const router = new RuntimeRouter(
      store,
      new MutableEligibility(contradictory),
      fixedClock(),
    );

    const route = await router.route(routeRequest('rust_preferred'));

    expect(route.runtimeGeneration).toBe('legacy_ts');
    expect(route.ineligibilityReasons).toEqual([
      { code: 'eligibility_result_invalid', dimension: 'eligibility' },
    ]);
  });

  it('fails closed when an atomic commit reports a competing route', async () => {
    const store = new MemoryRouteStore();
    const request = routeRequest();
    store.committedOverride = {
      ...(await new RuntimeRouter(
        new MemoryRouteStore(),
        new MutableEligibility({ eligible: false, reasons: [{
          code: 'rust_disabled',
          dimension: 'runtime',
        }] }),
        fixedClock(),
      ).route(request)),
      runtimeGeneration: 'legacy_ts',
      selectionReasonCode: 'rust_ineligible',
    };
    const router = new RuntimeRouter(
      store,
      new MutableEligibility({ eligible: true, reasons: [] }),
      fixedClock(),
    );

    await expect(router.route(request)).rejects.toBeInstanceOf(RuntimeRouteConflictError);
  });
});
