import { clone, equals } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
  packProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import type {
  HostHydrationItemDescriptor,
  HostHydrationSource,
} from '../ipc/HostDataHydration.js';
import { assertContainmentExpectation } from '../ipc/ContainmentProofValidation.js';
import { validateAttemptIdentity } from '../ipc/FrameHeaderValidation.js';
import { validateResourceBudget } from '../ipc/HostLaunchProvisionValidation.js';
import { validateExpectedProvenance } from '../ipc/HostSupervisorProvisionValidation.js';
import { validateActivationAuthoritySeal } from '../ipc/ActivationAuthoritySealValidation.js';
import {
  type ValidatedAttemptEndpointPlan,
  validateAttemptEndpointPlan,
} from './ShadowAttemptControlEndpointPlan.js';
import type { ShadowAttemptDataPlanInput } from './ShadowAttemptDataPlan.js';

const PREFERRED_CHUNK_BYTES = 900n * 1024n;
const ENVELOPE_SAFETY_BYTES = 64n * 1024n;
const PREFERRED_IO_TIMEOUT_MS = 30_000n;

export interface ValidatedShadowAttemptDataPlan {
  readonly identity: agentV1Common.AttemptIdentity;
  readonly resourceBudget: agentV1Common.ResourceBudget;
  readonly expectedRunnerProvenance:
    NonNullable<ShadowAttemptDataPlanInput['launch']['expectedRunnerProvenance']>;
  readonly endpoints: ValidatedAttemptEndpointPlan;
  readonly protocolVersion: number;
  readonly effectiveLimits: agentV1Common.FrameLimits;
  readonly source: HostHydrationSource;
}

export function validateShadowAttemptDataPlan(
  input: ShadowAttemptDataPlanInput,
): ValidatedShadowAttemptDataPlan {
  const launch = input.launch;
  if (!launch.identity || !launch.resourceBudget) {
    throw new RangeError('launch identity or budget');
  }
  validateAttemptIdentity(launch.identity);
  validateResourceBudget(launch.resourceBudget);
  validateExpectedProvenance(launch.expectedRunnerProvenance);
  validateActivationAuthoritySeal(launch.activationAuthoritySeal);
  assertContainmentExpectation(
    input.requiredContainmentLevel,
    input.requiredEnforcedLimits,
  );
  if (!sameSet(
    input.requiredEnforcedLimits,
    launch.requiredEnforcedLimits,
  )) throw new RangeError('containment requirements diverge');
  validateDeadlines(input);
  const endpoints = validateAttemptEndpointPlan(launch.protectedEndpoints);
  return {
    identity: launch.identity,
    resourceBudget: launch.resourceBudget,
    expectedRunnerProvenance: launch.expectedRunnerProvenance!,
    endpoints,
    protocolVersion: selectedProtocol(input.hostHello),
    effectiveLimits: deriveShadowAttemptDataFrameLimits(
      endpoints.data.maxFrameBytes,
      launch.resourceBudget,
    ),
    source: snapshotSource(
      input.source,
      input.expectedSnapshots,
      input.expectedArtifacts,
    ),
  };
}

export function closeHydrationSource(
  source: HostHydrationSource,
  cause: unknown,
): void {
  try {
    void Promise.resolve(source.close(cause)).catch(() => undefined);
  } catch {
    // Constructor or protocol failure remains authoritative.
  }
}

function validateDeadlines(input: ShadowAttemptDataPlanInput): void {
  const launch = input.launch;
  if (
    launch.hardDeadlineAtUnixMs <= 0n
    || launch.authorityLeaseExpiresAtUnixMs <= 0n
    || launch.authorityLeaseExpiresAtUnixMs > launch.hardDeadlineAtUnixMs
    || input.specDeadlineAtUnixMs <= 0n
    || input.specDeadlineAtUnixMs > launch.authorityLeaseExpiresAtUnixMs
  ) throw new RangeError('launch deadline');
}

function selectedProtocol(hostHello: agentV1Runtime.HostHello): number {
  const selected = hostHello.selectedProtocol;
  if (!selected || selected.major === 0) throw new RangeError('protocol');
  return packProtocolVersion(selected);
}

export function deriveShadowAttemptDataFrameLimits(
  endpointMaximumFrameBytes: bigint,
  budget: agentV1Common.ResourceBudget,
): agentV1Common.FrameLimits {
  const maximum = endpointMaximumFrameBytes < budget.maxIpcBytes
    ? endpointMaximumFrameBytes
    : budget.maxIpcBytes;
  const available = maximum - ENVELOPE_SAFETY_BYTES;
  const chunk = available < PREFERRED_CHUNK_BYTES
    ? available
    : PREFERRED_CHUNK_BYTES;
  const timeout = budget.maxWallMs < PREFERRED_IO_TIMEOUT_MS
    ? budget.maxWallMs
    : PREFERRED_IO_TIMEOUT_MS;
  if (maximum <= 0n || chunk <= 0n || timeout <= 0n) {
    throw new RangeError('data limits');
  }
  return createLimits(maximum, chunk, timeout);
}

function createLimits(
  maximum: bigint,
  chunk: bigint,
  timeout: bigint,
): agentV1Common.FrameLimits {
  return {
    $typeName: 'codestudio.agent.v1.FrameLimits',
    maxFrameBytes: maximum,
    maxChunkBytes: chunk,
    maxInFlightFrames: 1n,
    maxInFlightBytes: maximum,
    readTimeoutMs: timeout,
    writeTimeoutMs: timeout,
    transportCrc32c: false,
  };
}

function snapshotSource(
  source: HostHydrationSource,
  snapshots: readonly agentV1Common.SnapshotRef[],
  artifacts: readonly agentV1Artifact.ArtifactRef[],
): HostHydrationSource {
  if (
    typeof source.readExact !== 'function'
    || typeof source.close !== 'function'
    || source.items.length !== snapshots.length + artifacts.length
  ) throw new RangeError('hydration source');
  const items: HostHydrationItemDescriptor[] = [];
  for (let index = 0; index < source.items.length; index += 1) {
    items.push(snapshotSourceItem(
      source.items[index]!,
      snapshots,
      artifacts,
      index,
    ));
  }
  return Object.freeze({
    items: Object.freeze(items),
    readExact: source.readExact.bind(source),
    close: source.close.bind(source),
  });
}

function snapshotSourceItem(
  item: HostHydrationItemDescriptor,
  snapshots: readonly agentV1Common.SnapshotRef[],
  artifacts: readonly agentV1Artifact.ArtifactRef[],
  index: number,
): HostHydrationItemDescriptor {
  if (index < snapshots.length) {
    if (
      item.reference.case !== 'snapshot'
      || !equals(
        agentV1Common.SnapshotRefSchema,
        item.reference.value,
        snapshots[index]!,
      )
    ) throw new RangeError('snapshot source');
    return {
      reference: {
        case: 'snapshot',
        value: clone(
          agentV1Common.SnapshotRefSchema,
          item.reference.value,
        ),
      },
      byteLength: item.byteLength,
    };
  }
  const expected = artifacts[index - snapshots.length]!;
  if (
    item.reference.case !== 'artifact'
    || !equals(
      agentV1Artifact.ArtifactRefSchema,
      item.reference.value,
      expected,
    )
    || item.byteLength !== expected.byteLength
  ) throw new RangeError('artifact source');
  return {
    reference: {
      case: 'artifact',
      value: clone(
        agentV1Artifact.ArtifactRefSchema,
        item.reference.value,
      ),
    },
    byteLength: item.byteLength,
  };
}

function sameSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}
