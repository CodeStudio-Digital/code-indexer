import type {
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import type { AttemptTransportChannel } from './AttemptFrame.js';
import type { AuthorityClock } from './AttemptClock.js';
import type {
  AttemptCorrelationAuthority,
} from './AttemptCorrelationAuthority.js';
import type { FrameDirection } from './AttemptFrameDirection.js';

export interface OutboundAuthorityOptions {
  protocolVersion: number;
  connectionId: string;
  identity: agentV1Common.AttemptIdentity;
  channel: AttemptTransportChannel;
  direction: FrameDirection;
  maximumFrameBytes: number;
  committedStreamSeq: bigint;
  maximumResponseTimeoutMs: number;
  hardDeadlineAtUnixMs: bigint;
  clock: AuthorityClock;
  correlations: AttemptCorrelationAuthority;
}

export interface ResponseDeadlinePolicy {
  readonly timeoutMs: number;
}

export interface OutboundAuthorityState
  extends OutboundAuthorityOptions {
  senderId: string;
}
