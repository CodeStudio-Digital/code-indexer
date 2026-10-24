import { AgentRuntimeHostError } from '../errors.js';
import type {
  RuntimeIneligibilityReason,
  RuntimeIneligibilityReasonCode,
  RuntimeRouteRecord,
  RuntimeRouteRequest,
} from './types.js';

const INELIGIBILITY_CODES: ReadonlySet<RuntimeIneligibilityReasonCode> = new Set([
  'runtime_unavailable',
  'invalid_eligibility_input',
  'surface_unsupported',
  'platform_unsupported',
  'environment_unsupported',
  'provider_unsupported',
  'capability_profile_unsupported',
  'capability_catalog_unsupported',
  'capability_unsupported',
  'engine_version_unsupported',
  'build_id_unsupported',
  'binary_digest_mismatch',
  'protocol_version_unsupported',
  'containment_level_unsupported',
  'eligibility_check_failed',
  'eligibility_result_invalid',
]);

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validContainmentLevel(value: unknown): boolean {
  return value === 'hard_aggregate'
    || value === 'hard_process'
    || value === 'monitored';
}

function isValidReason(reason: unknown): reason is RuntimeIneligibilityReason {
  if (!reason || typeof reason !== 'object') return false;
  const candidate = reason as Partial<RuntimeIneligibilityReason>;
  return typeof candidate.code === 'string'
    && INELIGIBILITY_CODES.has(candidate.code as RuntimeIneligibilityReasonCode)
    && nonEmpty(candidate.dimension);
}

export function validateRouteRequest(request: RuntimeRouteRequest): void {
  const validPreference = request.preference === 'legacy_required';
  const values = [
    request.sessionId,
    request.agentRunId,
    request.attemptId,
    request.cohort,
    request.eligibility.surface,
    request.eligibility.platform,
    request.eligibility.environmentKind,
    request.eligibility.provider,
    request.eligibility.capabilityProfile,
    request.eligibility.capabilityCatalogVersion,
    request.eligibility.engineVersion,
    request.eligibility.runtimeBuildId,
    request.eligibility.runtimeBinarySha256,
    request.eligibility.protocolVersion,
    request.eligibility.requiredContainmentLevel,
  ];
  const validCapabilities = Array.isArray(request.eligibility.capabilityIds)
    && request.eligibility.capabilityIds.every(nonEmpty);
  if (
    !validPreference
    || values.some((value) => !nonEmpty(value))
    || !validCapabilities
    || !validDigest(request.eligibility.runtimeBinarySha256)
    || !validContainmentLevel(request.eligibility.requiredContainmentLevel)
  ) {
    throw new AgentRuntimeHostError(
      'invalid_routing_request',
      'Runtime routing requires valid identity, preference, cohort, and eligibility dimensions',
    );
  }
}

export function validateStoredRoute(record: RuntimeRouteRecord): void {
  const validGeneration = record.runtimeGeneration === 'legacy_ts';
  const validPreference = record.preference === 'legacy_required';
  const validReason = record.selectionReasonCode === 'legacy_required';
  const requiredStrings = [
    record.sessionId,
    record.agentRunId,
    record.attemptId,
    record.surface,
    record.platform,
    record.environmentKind,
    record.provider,
    record.capabilityProfile,
    record.capabilityCatalogVersion,
    record.engineVersion,
    record.runtimeBuildId,
    record.runtimeBinarySha256,
    record.protocolVersion,
    record.requiredContainmentLevel,
    record.cohort,
    record.selectedAt,
  ];
  const validCollections = Array.isArray(record.capabilityIds)
    && record.capabilityIds.every(nonEmpty)
    && Array.isArray(record.ineligibilityReasons)
    && record.ineligibilityReasons.every(isValidReason);
  const consistentDecision = record.runtimeGeneration === 'legacy_ts'
    && record.preference === 'legacy_required'
    && record.selectionReasonCode === 'legacy_required'
    && record.ineligibilityReasons.length === 0;
  if (
    record.schemaVersion !== 1
    || !validGeneration
    || !validPreference
    || !validReason
    || requiredStrings.some((value) => !nonEmpty(value))
    || !validCollections
    || !validDigest(record.runtimeBinarySha256)
    || !validContainmentLevel(record.requiredContainmentLevel)
    || !consistentDecision
    || Number.isNaN(Date.parse(record.selectedAt))
  ) {
    throw new AgentRuntimeHostError(
      'runtime_route_corrupt',
      `Attempt ${record.attemptId ?? '<unknown>'} has an invalid durable runtime route`,
    );
  }
}

export function sameRoute(
  left: RuntimeRouteRecord,
  right: RuntimeRouteRecord,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.sessionId === right.sessionId
    && left.agentRunId === right.agentRunId
    && left.attemptId === right.attemptId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.preference === right.preference
    && left.selectionReasonCode === right.selectionReasonCode
    && left.surface === right.surface
    && left.platform === right.platform
    && left.environmentKind === right.environmentKind
    && left.provider === right.provider
    && left.capabilityProfile === right.capabilityProfile
    && left.capabilityCatalogVersion === right.capabilityCatalogVersion
    && left.engineVersion === right.engineVersion
    && left.runtimeBuildId === right.runtimeBuildId
    && left.runtimeBinarySha256 === right.runtimeBinarySha256
    && left.protocolVersion === right.protocolVersion
    && left.requiredContainmentLevel === right.requiredContainmentLevel
    && left.cohort === right.cohort
    && JSON.stringify(left.capabilityIds) === JSON.stringify(right.capabilityIds)
    && JSON.stringify(left.ineligibilityReasons) === JSON.stringify(right.ineligibilityReasons);
}

export function routeMatchesRequest(
  route: RuntimeRouteRecord,
  request: RuntimeRouteRequest,
): boolean {
  return route.sessionId === request.sessionId
    && route.agentRunId === request.agentRunId
    && route.attemptId === request.attemptId
    && route.preference === request.preference
    && route.cohort === request.cohort
    && route.surface === request.eligibility.surface
    && route.platform === request.eligibility.platform
    && route.environmentKind === request.eligibility.environmentKind
    && route.provider === request.eligibility.provider
    && route.capabilityProfile === request.eligibility.capabilityProfile
    && route.capabilityCatalogVersion === request.eligibility.capabilityCatalogVersion
    && route.engineVersion === request.eligibility.engineVersion
    && route.runtimeBuildId === request.eligibility.runtimeBuildId
    && route.runtimeBinarySha256 === request.eligibility.runtimeBinarySha256
    && route.protocolVersion === request.eligibility.protocolVersion
    && route.requiredContainmentLevel
      === request.eligibility.requiredContainmentLevel
    && JSON.stringify(route.capabilityIds)
      === JSON.stringify(request.eligibility.capabilityIds);
}
