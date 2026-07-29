import { agentV1Common } from '@mcp/agent-runtime-contracts';

export interface ContainmentProofExpectation {
  readonly requiredLevel: agentV1Common.ContainmentLevel;
  readonly requiredLimits: readonly agentV1Common.ResourceLimitKind[];
}

export function assertContainmentProof(
  actual: agentV1Common.ContainmentReport | undefined,
  expected: ContainmentProofExpectation,
): void {
  assertContainmentExpectation(
    expected.requiredLevel,
    expected.requiredLimits,
  );
  if (
    !actual?.capabilities
    || !levelSatisfies(actual.level, expected.requiredLevel)
    || (
      (
        actual.level === agentV1Common.ContainmentLevel.HARD_AGGREGATE
        || actual.level === agentV1Common.ContainmentLevel.HARD_PROCESS
      )
      && !actual.capabilities.processTree
    )
  ) throw invalid();
  const enforced = limitSet(actual.enforcedLimits);
  const unsupported = limitSet(actual.unsupportedLimits);
  if (
    [...enforced].some((limit) => unsupported.has(limit))
    || enforced.size + unsupported.size !== ALL_LIMITS.length
    || expected.requiredLimits.some((limit) => !enforced.has(limit))
  ) throw invalid();
  for (const limit of enforced) {
    if (capabilityState(actual.capabilities, limit) === false) throw invalid();
  }
  for (const limit of unsupported) {
    if (capabilityState(actual.capabilities, limit) === true) throw invalid();
  }
}

export function assertContainmentExpectation(
  level: agentV1Common.ContainmentLevel,
  limits: readonly agentV1Common.ResourceLimitKind[],
): void {
  if (
    !validLevel(level)
    || limits.length === 0
    || limits.some((value) => !validLimit(value))
    || new Set(limits).size !== limits.length
  ) throw invalid();
}

function limitSet(
  values: readonly agentV1Common.ResourceLimitKind[],
): Set<agentV1Common.ResourceLimitKind> {
  const output = new Set<agentV1Common.ResourceLimitKind>();
  for (const value of values) {
    if (!validLimit(value) || output.has(value)) throw invalid();
    output.add(value);
  }
  return output;
}

function levelSatisfies(
  actual: agentV1Common.ContainmentLevel,
  required: agentV1Common.ContainmentLevel,
): boolean {
  if (!validLevel(actual)) return false;
  switch (required) {
    case agentV1Common.ContainmentLevel.HARD_AGGREGATE:
      return actual === agentV1Common.ContainmentLevel.HARD_AGGREGATE;
    case agentV1Common.ContainmentLevel.HARD_PROCESS:
      return (
        actual === agentV1Common.ContainmentLevel.HARD_AGGREGATE
        || actual === agentV1Common.ContainmentLevel.HARD_PROCESS
      );
    case agentV1Common.ContainmentLevel.MONITORED:
      return true;
    default:
      return false;
  }
}

function validLevel(value: agentV1Common.ContainmentLevel): boolean {
  return (
    value === agentV1Common.ContainmentLevel.HARD_AGGREGATE
    || value === agentV1Common.ContainmentLevel.HARD_PROCESS
    || value === agentV1Common.ContainmentLevel.MONITORED
  );
}

function validLimit(value: agentV1Common.ResourceLimitKind): boolean {
  return ALL_LIMITS.includes(value as (typeof ALL_LIMITS)[number]);
}

function capabilityState(
  capabilities: agentV1Common.ContainmentCapabilities,
  limit: agentV1Common.ResourceLimitKind,
): boolean | undefined {
  switch (limit) {
    case agentV1Common.ResourceLimitKind.MEMORY:
      return capabilities.memoryLimit;
    case agentV1Common.ResourceLimitKind.CPU_TIME:
      return capabilities.cpuLimit;
    case agentV1Common.ResourceLimitKind.WALL_TIME:
      return undefined;
    case agentV1Common.ResourceLimitKind.PROCESSES:
      return capabilities.processTree && capabilities.processCountLimit;
    case agentV1Common.ResourceLimitKind.OPEN_HANDLES:
      return capabilities.openFileLimit;
    case agentV1Common.ResourceLimitKind.SCRATCH_BYTES:
      return capabilities.filesystemQuota;
    case agentV1Common.ResourceLimitKind.THREADS:
    case agentV1Common.ResourceLimitKind.UNSPECIFIED:
      return false;
  }
}

const ALL_LIMITS = [
  agentV1Common.ResourceLimitKind.MEMORY,
  agentV1Common.ResourceLimitKind.CPU_TIME,
  agentV1Common.ResourceLimitKind.WALL_TIME,
  agentV1Common.ResourceLimitKind.PROCESSES,
  agentV1Common.ResourceLimitKind.THREADS,
  agentV1Common.ResourceLimitKind.OPEN_HANDLES,
  agentV1Common.ResourceLimitKind.SCRATCH_BYTES,
] as const;

function invalid(): RangeError {
  return new RangeError('containment proof is invalid');
}
