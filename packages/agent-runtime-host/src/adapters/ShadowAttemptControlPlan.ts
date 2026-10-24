import { timingSafeEqual } from 'node:crypto';
import { clone } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
  agentV1Supervisor,
  packProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import type { PreparedDurabilityPort } from '../driver/HostLifecycleTypes.js';
import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type { PackedProtocolRange } from '../ipc/HostLaunchAuthority.js';
import {
  validateActivationAuthoritySeal,
} from '../ipc/ActivationAuthoritySealValidation.js';
import {
  assertContainmentExpectation,
} from '../ipc/ContainmentProofValidation.js';
import {
  assertFrameIdentifier,
  validateAttemptIdentity,
} from '../ipc/FrameHeaderValidation.js';
import {
  validateResourceBudget,
} from '../ipc/HostLaunchProvisionValidation.js';
import {
  validateExpectedProvenance,
} from '../ipc/HostSupervisorProvisionValidation.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';
import {
  validateAttemptEndpointPlan,
} from './ShadowAttemptControlEndpointPlan.js';

const CONTROL_MAXIMUM_FRAME_BYTES = 256 * 1024;

export interface ShadowAttemptControlPlanInput {
  /** Use the attempt's existing monotonic anchor on every owned channel. */
  readonly clock?: AuthorityClock;
  readonly launch: agentV1Supervisor.LaunchAttemptProcess;
  readonly hostHello: agentV1Runtime.HostHello;
  readonly supportedProtocols: PackedProtocolRange;
  readonly expectedSnapshots: readonly agentV1Common.SnapshotRef[];
  readonly expectedArtifacts: readonly agentV1Artifact.ArtifactRef[];
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits:
    readonly agentV1Common.ResourceLimitKind[];
  readonly specDeadlineAtUnixMs: bigint;
  readonly outboundTimeoutMs: number;
  readonly durability: PreparedDurabilityPort;
  readonly validateAgentHello: (
    hello: agentV1Runtime.AgentHello,
  ) => void;
}

export interface ShadowAttemptControlPlan {
  readonly clock?: AuthorityClock;
  readonly identity: agentV1Common.AttemptIdentity;
  readonly resourceBudget: agentV1Common.ResourceBudget;
  readonly hardDeadlineAtUnixMs: bigint;
  readonly launchNonce: Uint8Array;
  readonly endpointId: string;
  readonly connectionId: string;
  readonly expectedEndpointIds: readonly string[];
  readonly expectedRunnerProvenance:
    agentV1Supervisor.ExpectedRuntimeProvenance;
  readonly activationAuthoritySeal: agentV1Common.ActivationAuthoritySeal;
  readonly hostHello: agentV1Runtime.HostHello;
  readonly supportedProtocols: PackedProtocolRange;
  readonly expectedSnapshots: readonly agentV1Common.SnapshotRef[];
  readonly expectedArtifacts: readonly agentV1Artifact.ArtifactRef[];
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits:
    readonly agentV1Common.ResourceLimitKind[];
  readonly specDeadlineAtUnixMs: bigint;
  readonly outboundTimeoutMs: number;
  readonly durability: PreparedDurabilityPort;
  readonly validateAgentHello: (
    hello: agentV1Runtime.AgentHello,
  ) => void;
}

export function snapshotShadowAttemptControlPlan(
  input: ShadowAttemptControlPlanInput,
): ShadowAttemptControlPlan {
  let launchNonce: Uint8Array | undefined;
  let hostHello: agentV1Runtime.HostHello | undefined;
  let activationAuthoritySeal:
    agentV1Common.ActivationAuthoritySeal | undefined;
  try {
    const commitPrepared = input.durability.commitPrepared;
    const launch = input.launch;
    if (!launch.identity || !launch.resourceBudget) {
      throw new RangeError('launch identity or budget');
    }
    validateAttemptIdentity(launch.identity);
    validateResourceBudget(launch.resourceBudget);
    validateExpectedProvenance(launch.expectedRunnerProvenance);
    validateActivationAuthoritySeal(launch.activationAuthoritySeal);
    validateDeadlines(input);
    assertContainmentExpectation(
      input.requiredContainmentLevel,
      input.requiredEnforcedLimits,
    );
    if (!sameSet(
      input.requiredEnforcedLimits,
      launch.requiredEnforcedLimits,
    )) throw new RangeError('containment requirements diverge');
    const endpoints = validateAttemptEndpointPlan(
      launch.protectedEndpoints,
    );
    const control = endpoints.control;
    validateHello(input, control, commitPrepared);
    const identity = clone(
      agentV1Common.AttemptIdentitySchema,
      launch.identity,
    );
    const resourceBudget = clone(
      agentV1Common.ResourceBudgetSchema,
      launch.resourceBudget,
    );
    const expectedRunnerProvenance = clone(
      agentV1Supervisor.ExpectedRuntimeProvenanceSchema,
      launch.expectedRunnerProvenance,
    );
    const expectedSnapshots = Object.freeze(
      input.expectedSnapshots.map((value) => (
        clone(agentV1Common.SnapshotRefSchema, value)
      )),
    );
    const expectedArtifacts = Object.freeze(
      input.expectedArtifacts.map((value) => (
        clone(agentV1Artifact.ArtifactRefSchema, value)
      )),
    );
    hostHello = clone(agentV1Runtime.HostHelloSchema, input.hostHello);
    activationAuthoritySeal = clone(
      agentV1Common.ActivationAuthoritySealSchema,
      launch.activationAuthoritySeal!,
    );
    launchNonce = launch.launchNonce.slice();
    return Object.freeze({
      ...(input.clock ? { clock: Object.freeze({ now: input.clock.now.bind(input.clock) }) } : {}),
      identity,
      resourceBudget,
      hardDeadlineAtUnixMs: launch.hardDeadlineAtUnixMs,
      launchNonce,
      endpointId: control.endpointId,
      connectionId: control.connectionId,
      expectedEndpointIds: Object.freeze(endpoints.ids),
      expectedRunnerProvenance,
      activationAuthoritySeal,
      hostHello,
      supportedProtocols: Object.freeze({ ...input.supportedProtocols }),
      expectedSnapshots,
      expectedArtifacts,
      requiredContainmentLevel: input.requiredContainmentLevel,
      requiredEnforcedLimits: Object.freeze([
        ...input.requiredEnforcedLimits,
      ]),
      specDeadlineAtUnixMs: input.specDeadlineAtUnixMs,
      outboundTimeoutMs: input.outboundTimeoutMs,
      durability: Object.freeze({
        commitPrepared: commitPrepared.bind(input.durability),
      }),
      validateAgentHello: input.validateAgentHello,
    });
  } catch (cause) {
    launchNonce?.fill(0);
    hostHello?.connectionSessionToken.fill(0);
    activationAuthoritySeal?.activationNonceSha256.fill(0);
    throw new AttemptControlAdapterError(
      'invalid_provision',
      'shadow control lifecycle plan is invalid',
      { cause },
    );
  }
}

export function scrubShadowAttemptControlPlan(
  plan: ShadowAttemptControlPlan | undefined,
): void {
  if (!plan) return;
  plan.launchNonce.fill(0);
  plan.hostHello.connectionSessionToken.fill(0);
  plan.activationAuthoritySeal.activationNonceSha256.fill(0);
}

function validateDeadlines(input: ShadowAttemptControlPlanInput): void {
  const launch = input.launch;
  if (
    launch.hardDeadlineAtUnixMs <= 0n
    || launch.authorityLeaseExpiresAtUnixMs <= 0n
    || launch.authorityLeaseExpiresAtUnixMs > launch.hardDeadlineAtUnixMs
    || input.specDeadlineAtUnixMs <= 0n
    || input.specDeadlineAtUnixMs > launch.hardDeadlineAtUnixMs
    || launch.launchNonce.byteLength < 16
    || launch.launchNonce.byteLength > 256
  ) throw new RangeError('launch deadline or nonce');
}

function validateHello(
  input: ShadowAttemptControlPlanInput,
  control: agentV1Supervisor.ProtectedAttemptEndpoint,
  commitPrepared: PreparedDurabilityPort['commitPrepared'],
): void {
  const hello = input.hostHello;
  const selected = hello.selectedProtocol;
  if (!selected || !hello.frameLimits) throw new RangeError('HostHello');
  const protocol = packProtocolVersion(selected);
  if (
    selected.major === 0
    || protocol < input.supportedProtocols.minimum
    || protocol > input.supportedProtocols.maximum
    || hello.connectionId !== control.connectionId
    || !sameBytes(hello.connectionSessionToken, control.connectionToken)
    || hello.frameLimits.maxFrameBytes
      !== BigInt(CONTROL_MAXIMUM_FRAME_BYTES)
    || !Number.isSafeInteger(input.outboundTimeoutMs)
    || input.outboundTimeoutMs <= 0
    || BigInt(input.outboundTimeoutMs) > hello.frameLimits.writeTimeoutMs
    || typeof commitPrepared !== 'function'
    || typeof input.validateAgentHello !== 'function'
  ) throw new RangeError('HostHello authority');
  assertFrameIdentifier(hello.contractVersion, 'contract_version');
}

function sameSet(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.byteLength > 0
    && timingSafeEqual(left, right);
}
