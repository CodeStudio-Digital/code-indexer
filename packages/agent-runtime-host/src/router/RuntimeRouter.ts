import type { AgentRunAttemptId } from '@mcp/agent-runtime-contracts';
import {
  AgentRuntimeHostError,
  RuntimeIneligibleError,
  RuntimeRouteConflictError,
} from '../errors.js';
import type {
  RuntimeClockPort,
  RuntimeEligibilityPort,
  RuntimeRouteStorePort,
} from './ports.js';
import type {
  RuntimeEligibilityDecision,
  RuntimeIneligibilityReason,
  RuntimeRouteRecord,
  RuntimeRouteRequest,
} from './types.js';
import {
  normalizeEligibilityDecision,
  routeMatchesRequest,
  sameRoute,
  validateRouteRequest,
  validateStoredRoute,
} from './validation.js';

const systemClock: RuntimeClockPort = {
  now: () => new Date(),
};

export class RuntimeRouter {
  constructor(
    private readonly store: RuntimeRouteStorePort,
    private readonly eligibility: RuntimeEligibilityPort,
    private readonly clock: RuntimeClockPort = systemClock,
  ) {}

  async route(request: RuntimeRouteRequest): Promise<RuntimeRouteRecord> {
    validateRouteRequest(request);

    const existing = await this.store.getByAttemptId(request.attemptId);
    if (existing) {
      validateStoredRoute(existing);
      this.assertRouteRequest(existing, request);
      return existing;
    }

    const candidate = await this.buildCandidate(request);
    const commit = await this.store.commitIfAbsent(candidate);
    validateStoredRoute(commit.record);
    if (!sameRoute(commit.record, candidate)) {
      throw new RuntimeRouteConflictError(commit.record, candidate);
    }
    return commit.record;
  }

  async getCommittedRoute(attemptId: AgentRunAttemptId): Promise<RuntimeRouteRecord> {
    const record = await this.store.getByAttemptId(attemptId);
    if (!record) {
      throw new AgentRuntimeHostError(
        'runtime_route_not_committed',
        `Attempt ${attemptId} has no durable runtime route`,
      );
    }
    validateStoredRoute(record);
    return record;
  }

  private async buildCandidate(request: RuntimeRouteRequest): Promise<RuntimeRouteRecord> {
    if (request.preference === 'legacy_required') {
      return this.toRecord(request, 'legacy_ts', 'legacy_required', []);
    }

    const decision = await this.evaluateFailClosed(request);
    if (decision.eligible) {
      return this.toRecord(request, 'rust_v1', 'rust_eligible', []);
    }
    if (request.preference === 'rust_required') {
      throw new RuntimeIneligibleError(decision);
    }
    return this.toRecord(
      request,
      'legacy_ts',
      'rust_ineligible',
      decision.reasons,
    );
  }

  private async evaluateFailClosed(
    request: RuntimeRouteRequest,
  ): Promise<RuntimeEligibilityDecision> {
    try {
      return normalizeEligibilityDecision(
        await this.eligibility.evaluate(request.eligibility),
      );
    } catch (error) {
      return {
        eligible: false,
        reasons: [{
          code: 'eligibility_check_failed',
          dimension: 'eligibility',
          detail: error instanceof Error ? error.message : 'Unknown eligibility error',
        }],
      };
    }
  }

  private toRecord(
    request: RuntimeRouteRequest,
    runtimeGeneration: RuntimeRouteRecord['runtimeGeneration'],
    selectionReasonCode: RuntimeRouteRecord['selectionReasonCode'],
    ineligibilityReasons: readonly RuntimeIneligibilityReason[],
  ): RuntimeRouteRecord {
    return {
      schemaVersion: 1,
      sessionId: request.sessionId,
      agentRunId: request.agentRunId,
      attemptId: request.attemptId,
      runtimeGeneration,
      preference: request.preference,
      selectionReasonCode,
      ineligibilityReasons: [...ineligibilityReasons],
      surface: request.eligibility.surface,
      platform: request.eligibility.platform,
      environmentKind: request.eligibility.environmentKind,
      provider: request.eligibility.provider,
      capabilityProfile: request.eligibility.capabilityProfile,
      capabilityCatalogVersion: request.eligibility.capabilityCatalogVersion,
      capabilityIds: [...request.eligibility.capabilityIds],
      engineVersion: request.eligibility.engineVersion,
      runtimeBuildId: request.eligibility.runtimeBuildId,
      runtimeBinarySha256: request.eligibility.runtimeBinarySha256,
      protocolVersion: request.eligibility.protocolVersion,
      requiredContainmentLevel: request.eligibility.requiredContainmentLevel,
      cohort: request.cohort,
      selectedAt: this.clock.now().toISOString(),
    };
  }

  private assertRouteRequest(
    existing: RuntimeRouteRecord,
    request: RuntimeRouteRequest,
  ): void {
    if (!routeMatchesRequest(existing, request)) {
      const candidate = this.toRecord(
        request,
        existing.runtimeGeneration,
        existing.selectionReasonCode,
        existing.ineligibilityReasons,
      );
      throw new RuntimeRouteConflictError(existing, candidate);
    }
  }
}
