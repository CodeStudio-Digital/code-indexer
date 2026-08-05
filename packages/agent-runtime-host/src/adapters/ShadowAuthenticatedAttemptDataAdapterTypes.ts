import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type { DurableEngineEventCommitPort } from '../ipc/DurableEngineEventCommitPort.js';
import type { HostDataBoundContext } from '../ipc/HostDataAttemptChannelValidation.js';
import type { ProviderGateway } from '../provider-gateway/ProviderGateway.js';
import type { ProtectedAttemptDataEndpointOwner } from './ProtectedAttemptDataEndpoint.js';
import type { ShadowAttemptDataPlanInput } from './ShadowAttemptDataPlan.js';
import type { CapabilityGateway } from '../capability-gateway/CapabilityGateway.js';

export type ProviderGatewayFactory = (
  context: HostDataBoundContext,
  clock: AuthorityClock,
) => ProviderGateway;

export type CapabilityGatewayFactory = (
  context: HostDataBoundContext,
  clock: AuthorityClock,
) => CapabilityGateway;

export interface ShadowAuthenticatedAttemptDataAdapterOptions
extends ShadowAttemptDataPlanInput {
  readonly endpoint: ProtectedAttemptDataEndpointOwner;
  readonly clock: AuthorityClock;
  readonly providerGateway?: ProviderGateway;
  readonly providerGatewayFactory?: ProviderGatewayFactory;
  readonly engineEventCommitter?: DurableEngineEventCommitPort;
  readonly capabilityGateway?: CapabilityGateway;
  readonly capabilityGatewayFactory?: CapabilityGatewayFactory;
}
