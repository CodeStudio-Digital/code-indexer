import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { ATTEMPT_FRAME_MAX_BYTES } from './AttemptFrame.js';
import {
  type AuthorityClock,
  createAuthorityClock,
} from './AttemptClock.js';

export const CONTROL_HARD_MAXIMUM = ATTEMPT_FRAME_MAX_BYTES[
  agentV1Runtime.TransportChannel.CONTROL
];

export type HostBootstrapState =
  | 'awaiting_agent_hello'
  | 'receiving_agent_hello'
  | 'agent_hello_accepted'
  | 'sending_host_hello'
  | 'handed_off'
  | 'failed';

interface ConstructionDependencies {
  readonly clock: AuthorityClock;
  readonly failureObserver?: (cause: unknown) => void;
}

const dependencies = new WeakMap<object, ConstructionDependencies>();

export function bindHostBootstrapConstruction(
  options: object,
  clock: AuthorityClock,
  failureObserver?: (cause: unknown) => void,
): void {
  dependencies.set(options, { clock, failureObserver });
}

export function takeHostBootstrapConstruction(
  options: object,
): ConstructionDependencies {
  const configured = dependencies.get(options);
  dependencies.delete(options);
  return configured ?? { clock: createAuthorityClock() };
}
