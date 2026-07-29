import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import {
  assertFrameIdentifier,
  validateAttemptIdentity,
} from './FrameHeaderValidation.js';
import { HostDataChannelError } from './HostDataChannelError.js';

const DATA_HARD_MAXIMUM = 1024 * 1024;
const MIN_SECRET_BYTES = 16;
const MAX_SECRET_BYTES = 512;

export interface HostDataBoundContext {
  readonly identity: agentV1Common.AttemptIdentity;
  readonly runtimeInstanceId: string;
  readonly limits: agentV1Common.FrameLimits;
  readonly timeoutMs: number;
}

export interface HostDataProvisionFacts {
  readonly transport: DelimitedByteChannel;
  readonly identity: agentV1Common.AttemptIdentity;
  readonly runtimeInstanceId: string;
  readonly connectionId: string;
  readonly connectionSessionToken: Uint8Array;
  readonly protocolVersion: number;
  readonly effectiveLimits: agentV1Common.FrameLimits;
  readonly maxIpcFrames: number;
}

export function validateHostDataProvision(
  value: HostDataProvisionFacts,
): HostDataBoundContext {
  validateAttemptIdentity(value.identity);
  assertFrameIdentifier(value.runtimeInstanceId, 'runtime_instance_id');
  assertFrameIdentifier(value.connectionId, 'connection_id');
  const limits = value.effectiveLimits;
  const maximum = limits.maxFrameBytes;
  const timeout = limits.writeTimeoutMs;
  if (
    !Number.isSafeInteger(value.protocolVersion)
    || value.protocolVersion <= 0
    || value.connectionSessionToken.byteLength < MIN_SECRET_BYTES
    || value.connectionSessionToken.byteLength > MAX_SECRET_BYTES
    || maximum <= 0n
    || maximum > BigInt(DATA_HARD_MAXIMUM)
    || limits.maxChunkBytes <= 0n
    || limits.maxChunkBytes >= maximum
    || limits.maxInFlightFrames !== 1n
    || limits.maxInFlightBytes !== maximum
    || limits.readTimeoutMs !== timeout
    || timeout <= 0n
    || timeout > BigInt(Number.MAX_SAFE_INTEGER)
    || limits.transportCrc32c
    || !Number.isInteger(value.maxIpcFrames)
    || value.maxIpcFrames < 6
    || value.maxIpcFrames > 65_536
    || value.transport.maximumFrameBytes !== Number(maximum)
    || value.transport.readTimeoutMs !== Number(timeout)
    || value.transport.writeTimeoutMs !== Number(timeout)
  ) throw invalid('data channel provision is invalid');
  return Object.freeze({
    identity: clone(agentV1Common.AttemptIdentitySchema, value.identity),
    runtimeInstanceId: value.runtimeInstanceId,
    limits: clone(agentV1Common.FrameLimitsSchema, limits),
    timeoutMs: Number(timeout),
  });
}

export function assertExactDataBinding(
  value: agentV1Runtime.AttemptChannelBound,
  context: HostDataBoundContext,
): void {
  const limits = value.effectiveLimits;
  if (
    value.runtimeInstanceId !== context.runtimeInstanceId
    || value.channel !== agentV1Runtime.TransportChannel.DATA
    || !limits
    || limits.maxFrameBytes !== context.limits.maxFrameBytes
    || limits.maxChunkBytes !== context.limits.maxChunkBytes
    || limits.maxInFlightFrames !== 1n
    || limits.maxInFlightBytes !== context.limits.maxFrameBytes
    || limits.readTimeoutMs !== context.limits.readTimeoutMs
    || limits.writeTimeoutMs !== context.limits.writeTimeoutMs
    || limits.transportCrc32c
  ) throw invalid('runner data limits diverge from launch authority');
}

function invalid(message: string): HostDataChannelError {
  return new HostDataChannelError('invalid_provision', message);
}