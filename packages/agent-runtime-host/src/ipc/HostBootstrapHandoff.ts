import { clone, create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { AuthorityClock } from './AttemptClock.js';
import type { BootstrapAgentHello } from './AttemptFrameBootstrapModels.js';
import { AttemptCorrelationAuthority } from './AttemptCorrelationAuthority.js';
import { AttemptFrameBootstrapError } from './AttemptFrameBootstrapError.js';
import { AttemptFrameReceiver } from './AttemptFrameReceiver.js';
import {
  inspectNegotiatedSeed,
  negotiatedSeedMatchesBinding,
} from './AttemptFrameSeed.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import {
  type EstablishedAttemptChannel,
} from './EstablishedAttemptChannel.js';
import {
  handoffEstablishedAttemptChannel,
} from './EstablishedAttemptChannelHandoff.js';
import type { HostLaunchState } from './HostLaunchAuthority.js';
import {
  type AgentHelloSelection,
  validateHostHelloForLaunch,
} from './HostLaunchValidation.js';
import {
  OutboundHeaderAuthority,
} from './OutboundHeaderAuthority.js';
import { sharedOutboundBytes } from './OutboundReservation.js';

export type BootstrapHandoffAuthority = Pick<
  HostLaunchState,
  | 'expectedIdentity'
  | 'expectedConnectionId'
  | 'expectedConnectionSessionToken'
  | 'expectedRuntimeInstanceId'
  | 'expectedContractVersion'
  | 'expectedContractSchemaVersion'
  | 'supportedProtocols'
  | 'receiverLimits'
  | 'maximumResponseTimeoutMs'
  | 'hardDeadlineAtUnixMs'
  | 'heartbeatPolicy'
  | 'featurePolicy'
>;

export function snapshotBootstrapHandoff(
  launch: HostLaunchState,
): BootstrapHandoffAuthority {
  return Object.freeze({
    expectedIdentity: clone(
      agentV1Common.AttemptIdentitySchema,
      launch.expectedIdentity,
    ),
    expectedConnectionId: launch.expectedConnectionId,
    expectedConnectionSessionToken:
      launch.expectedConnectionSessionToken.slice(),
    expectedRuntimeInstanceId: launch.expectedRuntimeInstanceId,
    expectedContractVersion: launch.expectedContractVersion,
    expectedContractSchemaVersion: launch.expectedContractSchemaVersion,
    supportedProtocols: Object.freeze({ ...launch.supportedProtocols }),
    receiverLimits: Object.freeze({ ...launch.receiverLimits }),
    maximumResponseTimeoutMs: launch.maximumResponseTimeoutMs,
    hardDeadlineAtUnixMs: launch.hardDeadlineAtUnixMs,
    heartbeatPolicy: Object.freeze({ ...launch.heartbeatPolicy }),
    featurePolicy: Object.freeze({ ...launch.featurePolicy }),
  });
}

export async function establishAttemptChannel(options: {
  readonly authority: BootstrapHandoffAuthority;
  readonly acceptedHello: BootstrapAgentHello;
  readonly agentSelection: AgentHelloSelection;
  readonly hostHello: agentV1Runtime.HostHello;
  readonly transport: DelimitedByteChannel;
  readonly hardMaximum: number;
  readonly binding: object;
  readonly owner: object;
  readonly clock: AuthorityClock;
  readonly failureObserver?: (cause: unknown) => void;
}): Promise<EstablishedAttemptChannel> {
  const selected = validateHostHelloForLaunch(
    options.hostHello,
    options.authority,
    options.agentSelection,
    options.hardMaximum,
    options.transport,
  );
  const seed = options.acceptedHello.negotiate(options.hostHello);
  if (!negotiatedSeedMatchesBinding(seed, options.binding)) {
    throw new AttemptFrameBootstrapError(
      'seed_channel_mismatch',
      'negotiated seed belongs to another bootstrap owner',
    );
  }
  const seedState = inspectNegotiatedSeed(seed);
  if (
    seedState.runtimeInstanceId
      !== options.authority.expectedRuntimeInstanceId
  ) {
    throw new AttemptFrameBootstrapError(
      'runtime_instance_mismatch',
      'negotiated receiver runtime mismatches launch',
    );
  }
  const correlations = new AttemptCorrelationAuthority(
    options.authority.receiverLimits.totalIdentityCapacity,
  );
  const receiver = new AttemptFrameReceiver(
    seed,
    options.authority.receiverLimits,
    correlations,
  );
  const sender = new OutboundHeaderAuthority({
    protocolVersion: selected.protocolVersion,
    connectionId: options.authority.expectedConnectionId,
    identity: options.authority.expectedIdentity,
    channel: agentV1Runtime.TransportChannel.CONTROL,
    direction: 'host_to_runner',
    maximumFrameBytes: options.hardMaximum,
    committedStreamSeq: 0n,
    maximumResponseTimeoutMs:
      options.authority.maximumResponseTimeoutMs,
    hardDeadlineAtUnixMs: options.authority.hardDeadlineAtUnixMs,
    clock: options.clock,
    correlations,
  });
  const payload = create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'hostHello',
      value: clone(
        agentV1Runtime.HostHelloSchema,
        options.hostHello,
      ),
    },
  });
  const outbound = sender.prepareBootstrapHostHello(payload);
  await options.transport.send(
    sharedOutboundBytes(outbound),
    options.owner,
  );
  sender.commit(outbound);
  sender.narrowMaximumFrameBytes(seedState.maximumFrameBytes);
  options.transport.narrowMaximumFrameBytes(
    seedState.maximumFrameBytes,
    options.owner,
  );
  return handoffEstablishedAttemptChannel(
    options.transport,
    receiver,
    sender,
    options.owner,
    options.clock,
    options.authority.hardDeadlineAtUnixMs,
    options.authority.maximumResponseTimeoutMs,
    options.failureObserver,
  );
}
