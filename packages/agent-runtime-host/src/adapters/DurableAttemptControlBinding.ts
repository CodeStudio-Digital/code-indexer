import { timingSafeEqual } from 'node:crypto';
import { clone, equals } from '@bufbuild/protobuf';
import {
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import type {
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import {
  assertContainmentProof,
} from '../ipc/ContainmentProofValidation.js';
import {
  assertFrameIdentifier,
  attemptIdentityEqual,
} from '../ipc/FrameHeaderValidation.js';
import {
  expectedProvenanceMatches,
} from '../ipc/HostSupervisorProvisionValidation.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';
export interface DurableAttemptBindingPlan {
  readonly identity: agentV1Common.AttemptIdentity;
  readonly resourceBudget: agentV1Common.ResourceBudget;
  readonly hardDeadlineAtUnixMs: bigint;
  readonly expectedEndpointIds: readonly string[];
  readonly expectedRunnerProvenance:
    Parameters<typeof expectedProvenanceMatches>[0];
  readonly specDeadlineAtUnixMs: bigint;
  readonly activationAuthoritySeal: agentV1Common.ActivationAuthoritySeal;
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits:
    readonly agentV1Common.ResourceLimitKind[];
}

export interface BoundDurableAttemptLaunch {
  readonly reservationId: string;
  readonly resourceGroupId: string;
  readonly runtimeInstanceId: string;
  readonly runnerProvenance: agentV1Common.RuntimeProvenance;
}

export type BoundDurableAttemptControlLaunch =
  BoundDurableAttemptLaunch;

export function bindDurableAttemptControlLaunch(
  snapshot: DurableSupervisorLaunchSnapshot,
  plan: DurableAttemptBindingPlan,
): BoundDurableAttemptControlLaunch {
  return bindDurableAttemptLaunch(snapshot, plan, 'control');
}

export function bindDurableAttemptDataLaunch(
  snapshot: DurableSupervisorLaunchSnapshot,
  plan: DurableAttemptBindingPlan,
): BoundDurableAttemptLaunch {
  return bindDurableAttemptLaunch(snapshot, plan, 'data');
}

function bindDurableAttemptLaunch(
  snapshot: DurableSupervisorLaunchSnapshot,
  plan: DurableAttemptBindingPlan,
  channel: 'control' | 'data',
): BoundDurableAttemptLaunch {
  try {
    const accepted = snapshot.accepted;
    const spawned = snapshot.spawned;
    const containment = snapshot.containment;
    const identities = [
      accepted.identity,
      spawned.identity,
      containment.identity,
    ];
    if (
      identities.some((identity) => (
        !identity || !attemptIdentityEqual(identity, plan.identity)
      ))
      || !accepted.reservedBudget
      || !containment.requestedBudget
      || !equals(
        agentV1Common.ResourceBudgetSchema,
        accepted.reservedBudget,
        plan.resourceBudget,
      )
      || !equals(
        agentV1Common.ResourceBudgetSchema,
        containment.requestedBudget,
        plan.resourceBudget,
      )
      || accepted.hardDeadlineAtUnixMs !== plan.hardDeadlineAtUnixMs
      || accepted.reservationId !== spawned.reservationId
      || !exactSet(spawned.endpointIds, plan.expectedEndpointIds)
      || !spawned.runnerProvenance
      || !expectedProvenanceMatches(
        plan.expectedRunnerProvenance,
        spawned.runnerProvenance,
      )
      || containment.runtimeInstanceId
        !== spawned.runnerProvenance.runtimeInstanceId
      || accepted.acceptedAtUnixMs <= 0n
      || spawned.spawnedAtUnixMs < accepted.acceptedAtUnixMs
      || containment.reportedAtUnixMs < spawned.spawnedAtUnixMs
      || containment.reportedAtUnixMs >= plan.specDeadlineAtUnixMs
      || !sameSeal(
        snapshot.activationAuthoritySeal,
        plan.activationAuthoritySeal,
      )
    ) throw new RangeError('durable launch facts diverge');
    assertFrameIdentifier(accepted.reservationId, 'reservation_id');
    assertFrameIdentifier(spawned.resourceGroupId, 'resource_group_id');
    assertFrameIdentifier(
      spawned.runnerProvenance.runtimeInstanceId,
      'runtime_instance_id',
    );
    if (
      !Number.isInteger(spawned.runnerProvenance.pid)
      || spawned.runnerProvenance.pid <= 0
      || spawned.runnerProvenance.pid > 0xffff_ffff
    ) throw new RangeError('runner PID');
    assertContainmentProof(containment.effectiveContainment, {
      requiredLevel: plan.requiredContainmentLevel,
      requiredLimits: plan.requiredEnforcedLimits,
    });
    return Object.freeze({
      reservationId: accepted.reservationId,
      resourceGroupId: spawned.resourceGroupId,
      runtimeInstanceId: spawned.runnerProvenance.runtimeInstanceId,
      runnerProvenance: clone(
        agentV1Common.RuntimeProvenanceSchema,
        spawned.runnerProvenance,
      ),
    });
  } catch (cause) {
    throw new AttemptControlAdapterError(
      'invalid_launch_binding',
      `durable supervisor facts cannot bind the ${channel} endpoint`,
      { cause },
    );
  }
}

function exactSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && new Set(expected).size === expected.length
    && actual.every((value) => expected.includes(value));
}

function sameSeal(
  left: agentV1Common.ActivationAuthoritySeal,
  right: agentV1Common.ActivationAuthoritySeal,
): boolean {
  return left.agentRunVersion === right.agentRunVersion
    && left.attemptVersion === right.attemptVersion
    && left.activationNonceSha256.byteLength === 32
    && right.activationNonceSha256.byteLength === 32
    && timingSafeEqual(
      left.activationNonceSha256,
      right.activationNonceSha256,
    );
}
