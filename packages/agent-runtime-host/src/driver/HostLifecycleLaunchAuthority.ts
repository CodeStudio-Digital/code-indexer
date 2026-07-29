import type {
  agentV1Artifact,
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import {
  type HostLaunchBinding,
  type HostLaunchProvision,
  HostLaunchAuthority,
} from '../ipc/HostLaunchAuthority.js';
import {
  scrubActivationAuthoritySeal,
  snapshotActivationAuthoritySeal,
} from '../ipc/ActivationAuthoritySealValidation.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import type {
  PreparedFactsExpectation,
} from './PreparedFactsTypes.js';
import {
  snapshotPreparedFactsExpectation,
} from './PreparedFactsExpectation.js';

export interface HostLifecycleLaunchProvision
  extends HostLaunchProvision {
  readonly expectedSnapshots: readonly agentV1Common.SnapshotRef[];
  readonly expectedArtifacts: readonly agentV1Artifact.ArtifactRef[];
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly requiredEnforcedLimits:
    readonly agentV1Common.ResourceLimitKind[];
  readonly specDeadlineAtUnixMs: bigint;
  readonly activationAuthoritySeal: agentV1Common.ActivationAuthoritySeal;
}

declare const LIFECYCLE_LAUNCH_BRAND: unique symbol;

export interface HostLifecycleLaunchBinding {
  readonly [LIFECYCLE_LAUNCH_BRAND]: never;
}

export interface HostLifecycleLaunchState {
  readonly bootstrapLaunch: HostLaunchBinding;
  readonly preparedExpectation: PreparedFactsExpectation;
  readonly maximumActivationDeadlineAtUnixMs: bigint;
  readonly activationAuthoritySeal: agentV1Common.ActivationAuthoritySeal;
}

class HostLifecycleLaunchBindingValue
  implements HostLifecycleLaunchBinding {
  declare readonly [LIFECYCLE_LAUNCH_BRAND]: never;
}

const authentic = new WeakSet<object>();
const states = new WeakMap<object, HostLifecycleLaunchState>();

export class HostLifecycleLaunchAuthority {
  static provision(
    provision: HostLifecycleLaunchProvision,
  ): HostLifecycleLaunchBinding {
    if (
      provision.specDeadlineAtUnixMs <= 0n
      || provision.specDeadlineAtUnixMs
        > provision.hardDeadlineAtUnixMs
    ) {
      throw new HostLifecycleDriverError(
        'invalid_prepared_expectation',
        'spec deadline exceeds immutable launch authority',
      );
    }
    const activationAuthoritySeal = snapshotActivationAuthoritySeal(
      provision.activationAuthoritySeal,
    );
    try {
      const preparedExpectation = snapshotPreparedFactsExpectation({
        expectedSnapshots: provision.expectedSnapshots,
        expectedArtifacts: provision.expectedArtifacts,
        resourceBudget: provision.resourceBudget,
        requiredContainmentLevel: provision.requiredContainmentLevel,
        requiredEnforcedLimits: provision.requiredEnforcedLimits,
        runtimeInstanceId: provision.expectedRuntimeInstanceId,
        ownerSessionId: provision.expectedIdentity.sessionId,
      });
      const bootstrapLaunch = HostLaunchAuthority.provision(
        bootstrapProvision(provision),
      );
      const binding = Object.freeze(
        new HostLifecycleLaunchBindingValue(),
      );
      authentic.add(binding);
      states.set(binding, Object.freeze({
        bootstrapLaunch,
        preparedExpectation,
        maximumActivationDeadlineAtUnixMs:
          provision.specDeadlineAtUnixMs,
        activationAuthoritySeal,
      }));
      return binding;
    } catch (cause) {
      scrubActivationAuthoritySeal(activationAuthoritySeal);
      throw cause;
    }
  }
}

export function consumeHostLifecycleLaunchBinding(
  binding: HostLifecycleLaunchBinding,
): HostLifecycleLaunchState {
  if (!authentic.has(binding)) {
    throw invalidBinding('lifecycle launch binding is not authentic');
  }
  const state = states.get(binding);
  if (!state) {
    throw invalidBinding('lifecycle launch binding was already consumed');
  }
  states.delete(binding);
  return state;
}

function bootstrapProvision(
  value: HostLifecycleLaunchProvision,
): HostLaunchProvision {
  return {
    transport: value.transport,
    expectedIdentity: value.expectedIdentity,
    expectedConnectionId: value.expectedConnectionId,
    expectedConnectionSessionToken: value.expectedConnectionSessionToken,
    expectedLaunchNonce: value.expectedLaunchNonce,
    expectedRuntimeInstanceId: value.expectedRuntimeInstanceId,
    expectedContractVersion: value.expectedContractVersion,
    expectedContractSchemaVersion: value.expectedContractSchemaVersion,
    expectedProvenance: value.expectedProvenance,
    supportedProtocols: value.supportedProtocols,
    resourceBudget: value.resourceBudget,
    hardDeadlineAtUnixMs: value.specDeadlineAtUnixMs,
    heartbeatPolicy: value.heartbeatPolicy,
    featurePolicy: value.featurePolicy,
    validateAgentHello: value.validateAgentHello,
  };
}

function invalidBinding(message: string): HostLifecycleDriverError {
  return new HostLifecycleDriverError(
    'invalid_prepared_expectation',
    message,
  );
}
