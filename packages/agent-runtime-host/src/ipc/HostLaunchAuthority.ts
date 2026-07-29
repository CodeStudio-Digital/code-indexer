import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import { AttemptFrameBootstrapError } from './AttemptFrameBootstrapError.js';
import type {
  HostLaunchProvision,
  HostLaunchState,
} from './HostLaunchTypes.js';
import {
  deriveLaunchLimits,
  validateHostLaunchProvision,
} from './HostLaunchProvisionValidation.js';

export type {
  HostFeaturePolicy,
  HostHeartbeatPolicy,
} from './HostNegotiationPolicy.js';
export type {
  ExpectedRuntimeProvenance,
  HostLaunchProvision,
  HostLaunchState,
  PackedProtocolRange,
} from './HostLaunchTypes.js';

declare const HOST_LAUNCH_BRAND: unique symbol;

export interface HostLaunchBinding {
  readonly [HOST_LAUNCH_BRAND]: never;
}

class HostLaunchBindingValue implements HostLaunchBinding {
  declare readonly [HOST_LAUNCH_BRAND]: never;
}

const authenticBindings = new WeakSet<object>();
const consumedBindings = new WeakSet<object>();
const launchStates = new WeakMap<object, HostLaunchState>();

export class HostLaunchAuthority {
  static provision(provision: HostLaunchProvision): HostLaunchBinding {
    validateHostLaunchProvision(provision);
    const state = snapshot(provision);
    const binding = Object.freeze(new HostLaunchBindingValue());
    authenticBindings.add(binding);
    launchStates.set(binding, state);
    return binding;
  }
}

export function consumeHostLaunchBinding(
  binding: HostLaunchBinding,
): HostLaunchState {
  if (!authenticBindings.has(binding)) {
    throw bootstrapError('invalid_launch_binding', 'launch binding is not authentic');
  }
  if (consumedBindings.has(binding)) {
    throw bootstrapError('launch_binding_consumed', 'launch binding was already consumed');
  }
  const state = launchStates.get(binding);
  if (!state) {
    throw bootstrapError('invalid_launch_binding', 'launch authority was revoked');
  }
  launchStates.delete(binding);
  consumedBindings.add(binding);
  return state;
}

function snapshot(provision: HostLaunchProvision): HostLaunchState {
  return Object.freeze({
    ...provision,
    expectedIdentity: clone(
      agentV1Common.AttemptIdentitySchema,
      provision.expectedIdentity,
    ),
    expectedLaunchNonce: provision.expectedLaunchNonce.slice(),
    expectedConnectionSessionToken:
      provision.expectedConnectionSessionToken.slice(),
    expectedProvenance: Object.freeze({
      ...provision.expectedProvenance,
      binarySha256: provision.expectedProvenance.binarySha256.slice(),
    }),
    supportedProtocols: Object.freeze({ ...provision.supportedProtocols }),
    resourceBudget: clone(
      agentV1Common.ResourceBudgetSchema,
      provision.resourceBudget,
    ),
    heartbeatPolicy: Object.freeze({ ...provision.heartbeatPolicy }),
    featurePolicy: Object.freeze({ ...provision.featurePolicy }),
    ...deriveLaunchLimits(provision.resourceBudget),
  });
}

function bootstrapError(
  code: ConstructorParameters<typeof AttemptFrameBootstrapError>[0],
  message: string,
): AttemptFrameBootstrapError {
  return new AttemptFrameBootstrapError(code, message);
}
