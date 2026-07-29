import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
  packProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import { AttemptFrameBootstrapError } from './AttemptFrameBootstrapError.js';
import {
  type NegotiatedReceiverSeed,
  mintNegotiatedSeed,
} from './AttemptFrameSeed.js';
import { assertFrameIdentifier } from './FrameHeaderValidation.js';

export interface HostSelection {
  protocolVersion: number;
  connectionId: string;
  maximumFrameBytes: number;
}

export interface BootstrapAgentHello {
  takeHello(): agentV1Runtime.AgentHello;
  headerProtocolVersion(): number;
  envelopeDigest(): Uint8Array;
  negotiate(hostHello: agentV1Runtime.HostHello): NegotiatedReceiverSeed;
}

class BootstrapAgentHelloValue implements BootstrapAgentHello {
  #consumed = false;
  #value?: agentV1Runtime.AgentHello;
  constructor(
    value: agentV1Runtime.AgentHello,
    private readonly protocolVersion: number,
    private readonly runtimeInstanceId: string,
    private readonly digest: Uint8Array,
    private readonly identityValue: agentV1Common.AttemptIdentity,
    private readonly messageId: string,
    private readonly binding: object,
    private readonly hardMaximum: number,
  ) {
    this.#value = value;
  }
  takeHello() {
    const value = this.#value;
    if (!value) throw bootstrapConsumed();
    this.#value = undefined;
    return clone(agentV1Runtime.AgentHelloSchema, value);
  }
  headerProtocolVersion() { return this.protocolVersion; }
  envelopeDigest() { return this.digest.slice(); }
  negotiate(hostHello: agentV1Runtime.HostHello) {
    if (this.#consumed) throw bootstrapConsumed();
    this.#consumed = true;
    const selected = validateHostSelection(hostHello, this.hardMaximum);
    return mintNegotiatedSeed({
      ...selected,
      runtimeInstanceId: this.runtimeInstanceId,
      identity: this.identityValue,
      channel: agentV1Runtime.TransportChannel.CONTROL,
      direction: 'runner_to_host',
      streamWatermark: 1n,
      bootstrapMessageId: this.messageId,
      bootstrapBinding: this.binding,
    });
  }
}

const authenticAgentHellos = new WeakSet<object>();

export function createBootstrapAgentHello(
  hello: agentV1Runtime.AgentHello,
  protocolVersion: number,
  digest: Uint8Array,
  identity: agentV1Common.AttemptIdentity,
  messageId: string,
  binding: object,
  hardMaximum: number,
): BootstrapAgentHello {
  const value = new BootstrapAgentHelloValue(
    clone(agentV1Runtime.AgentHelloSchema, hello),
    protocolVersion,
    hello.provenance?.runtimeInstanceId ?? '',
    digest.slice(),
    clone(agentV1Common.AttemptIdentitySchema, identity),
    messageId,
    binding,
    hardMaximum,
  );
  authenticAgentHellos.add(value);
  return Object.freeze(value);
}

export interface BootstrapHostHello {
  hello(): agentV1Runtime.HostHello;
  takeSeed(): NegotiatedReceiverSeed;
}

class BootstrapHostHelloValue implements BootstrapHostHello {
  #seed?: NegotiatedReceiverSeed;
  constructor(
    private readonly value: agentV1Runtime.HostHello,
    seed: NegotiatedReceiverSeed,
  ) {
    this.#seed = seed;
  }
  hello() { return clone(agentV1Runtime.HostHelloSchema, this.value); }
  takeSeed() {
    const seed = this.#seed;
    if (!seed) throw bootstrapConsumed();
    this.#seed = undefined;
    return seed;
  }
}

const authenticHostHellos = new WeakSet<object>();

export function createBootstrapHostHello(
  hello: agentV1Runtime.HostHello,
  seed: NegotiatedReceiverSeed,
): BootstrapHostHello {
  const value = new BootstrapHostHelloValue(
    clone(agentV1Runtime.HostHelloSchema, hello),
    seed,
  );
  authenticHostHellos.add(value);
  return Object.freeze(value);
}

export type BootstrapReceiveOutcome =
  | { readonly kind: 'agent_hello'; readonly hello: BootstrapAgentHello }
  | { readonly kind: 'host_hello'; readonly hello: BootstrapHostHello };

export function validateHostSelection(
  hello: agentV1Runtime.HostHello,
  hardMaximum: number,
): HostSelection {
  const selected = hello.selectedProtocol;
  if (!selected) {
    throw new AttemptFrameBootstrapError(
      'missing_selected_protocol',
      'HostHello selected protocol is missing',
    );
  }
  let protocolVersion: number;
  try {
    protocolVersion = packProtocolVersion(selected);
  } catch (cause) {
    throw new AttemptFrameBootstrapError(
      'invalid_selected_protocol',
      'HostHello selected protocol is invalid',
      { cause },
    );
  }
  if (selected.major === 0) {
    throw new AttemptFrameBootstrapError(
      'invalid_selected_protocol',
      'HostHello protocol major must be positive',
    );
  }
  try {
    assertFrameIdentifier(hello.connectionId, 'connection_id');
  } catch (cause) {
    throw new AttemptFrameBootstrapError(
      'invalid_selected_connection',
      'HostHello connection ID is invalid',
      { cause },
    );
  }
  const maximum = hello.frameLimits?.maxFrameBytes;
  if (
    maximum === undefined
    || maximum <= 0n
    || maximum > BigInt(hardMaximum)
  ) {
    throw new AttemptFrameBootstrapError(
      hello.frameLimits ? 'invalid_negotiated_maximum' : 'missing_frame_limits',
      'HostHello frame maximum is invalid',
    );
  }
  const limits = hello.frameLimits!;
  if (
    limits.maxInFlightFrames !== 1n
    || limits.maxInFlightBytes !== maximum
    || limits.transportCrc32c
  ) {
    throw new AttemptFrameBootstrapError(
      'unsupported_frame_limits',
      'HostHello window or checksum mode is unsupported by the V1 transport',
    );
  }
  return {
    protocolVersion,
    connectionId: hello.connectionId,
    maximumFrameBytes: Number(maximum),
  };
}

export function bootstrapConsumed(): AttemptFrameBootstrapError {
  return new AttemptFrameBootstrapError(
    'bootstrap_consumed',
    'bootstrap token was already consumed',
  );
}
