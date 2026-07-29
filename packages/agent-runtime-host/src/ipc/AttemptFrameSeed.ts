import { clone } from '@bufbuild/protobuf';
import { agentV1Common } from '@mcp/agent-runtime-contracts';
import type { AttemptTransportChannel } from './AttemptFrame.js';
import type { FrameDirection } from './AttemptFrameDirection.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';

interface SeedState {
  protocolVersion: number;
  connectionId: string;
  runtimeInstanceId: string;
  identity: agentV1Common.AttemptIdentity;
  channel: AttemptTransportChannel;
  direction: FrameDirection;
  maximumFrameBytes: number;
  streamWatermark: bigint;
  bootstrapMessageId: string;
  bootstrapBinding: object;
  consumed: boolean;
}

export type NegotiatedSeedSnapshot = Omit<
  SeedState,
  'bootstrapBinding' | 'consumed'
>;

export interface NegotiatedReceiverSeed {
  readonly protocolVersion: number;
  readonly connectionId: string;
  readonly channel: AttemptTransportChannel;
  readonly direction: FrameDirection;
  readonly maximumFrameBytes: number;
  readonly streamWatermark: bigint;
  identity(): agentV1Common.AttemptIdentity;
}

class NegotiatedReceiverSeedValue implements NegotiatedReceiverSeed {
  constructor(private readonly state: SeedState) {}
  get protocolVersion() { return this.state.protocolVersion; }
  get connectionId() { return this.state.connectionId; }
  get channel() { return this.state.channel; }
  get direction() { return this.state.direction; }
  get maximumFrameBytes() { return this.state.maximumFrameBytes; }
  get streamWatermark() { return this.state.streamWatermark; }
  identity() {
    return clone(agentV1Common.AttemptIdentitySchema, this.state.identity);
  }
}

const authenticSeeds = new WeakSet<object>();
const seedStates = new WeakMap<object, SeedState>();

export function mintNegotiatedSeed(
  value: Omit<SeedState, 'identity' | 'consumed'> & {
    identity: agentV1Common.AttemptIdentity;
  },
): NegotiatedReceiverSeed {
  const state: SeedState = {
    ...value,
    identity: clone(agentV1Common.AttemptIdentitySchema, value.identity),
    consumed: false,
  };
  const seed = new NegotiatedReceiverSeedValue(state);
  authenticSeeds.add(seed);
  seedStates.set(seed, state);
  return Object.freeze(seed);
}

export function inspectNegotiatedSeed(
  seed: NegotiatedReceiverSeed,
): NegotiatedSeedSnapshot {
  if (!authenticSeeds.has(seed)) {
    throw new AttemptFrameReceiverError('invalid_seed', 'receiver seed is not authentic');
  }
  const state = seedStates.get(seed)!;
  return {
    protocolVersion: state.protocolVersion,
    connectionId: state.connectionId,
    runtimeInstanceId: state.runtimeInstanceId,
    identity: clone(agentV1Common.AttemptIdentitySchema, state.identity),
    channel: state.channel,
    direction: state.direction,
    maximumFrameBytes: state.maximumFrameBytes,
    streamWatermark: state.streamWatermark,
    bootstrapMessageId: state.bootstrapMessageId,
  };
}

export function negotiatedSeedMatchesBinding(
  seed: NegotiatedReceiverSeed,
  binding: object,
): boolean {
  if (!authenticSeeds.has(seed)) return false;
  return seedStates.get(seed)!.bootstrapBinding === binding;
}

export function consumeNegotiatedSeed(
  seed: NegotiatedReceiverSeed,
): NegotiatedSeedSnapshot {
  const state = inspectNegotiatedSeed(seed);
  const stored = seedStates.get(seed)!;
  if (stored.consumed) {
    throw new AttemptFrameReceiverError('invalid_seed', 'receiver seed was already consumed');
  }
  stored.consumed = true;
  return state;
}
