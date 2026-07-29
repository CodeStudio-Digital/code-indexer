import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { AuthorityClock } from './AttemptClock.js';
import { AttemptCorrelationAuthority } from './AttemptCorrelationAuthority.js';
import { AttemptFrameReceiver } from './AttemptFrameReceiver.js';
import { mintNegotiatedSeed } from './AttemptFrameSeed.js';
import { DelimitedByteChannel } from './DelimitedByteChannel.js';
import type { EstablishedAttemptChannel } from './EstablishedAttemptChannel.js';
import { handoffEstablishedAttemptChannel } from './EstablishedAttemptChannelHandoff.js';
import {
  type HostDataBoundContext,
  assertExactDataBinding,
  validateHostDataProvision,
} from './HostDataAttemptChannelValidation.js';
import { HostDataChannelError } from './HostDataChannelError.js';
import { OutboundHeaderAuthority } from './OutboundHeaderAuthority.js';
import type {
  HostDataHydrationRequest,
  HostDataHydrationReceipt,
} from './HostDataHydration.js';
import { sendHostDataHydration } from './HostDataHydration.js';

const DATA_TOMBSTONE_ID = '00000000-0000-4000-8000-000000000000';
const DATA_REPLAY_ENTRIES = 8;
export interface HostDataAttemptChannelProvision {
  readonly transport: DelimitedByteChannel;
  readonly identity: agentV1Common.AttemptIdentity;
  readonly runtimeInstanceId: string;
  readonly connectionId: string;
  readonly connectionSessionToken: Uint8Array;
  readonly protocolVersion: number;
  readonly effectiveLimits: agentV1Common.FrameLimits;
  readonly maxIpcFrames: number;
  readonly hardDeadlineAtUnixMs: bigint;
  readonly clock: AuthorityClock;
  readonly failureObserver?: (cause: unknown) => void;
}

export class HostPendingDataAttemptChannel {
  #channel?: EstablishedAttemptChannel;
  #token?: Uint8Array;
  constructor(
    channel: EstablishedAttemptChannel,
    token: Uint8Array,
    private readonly context: HostDataBoundContext,
  ) {
    this.#channel = channel;
    this.#token = token;
  }

  async bind(): Promise<HostBoundDataAttemptChannel> {
    const channel = this.#requireChannel();
    const token = this.#token!;
    const payloadToken = token.slice();
    try {
      const outbound = await channel.sendNew(create(
        agentV1Runtime.FramePayloadSchema,
        {
          body: {
            case: 'bindAttemptChannel',
            value: {
              identity: this.context.identity,
              runtimeInstanceId: this.context.runtimeInstanceId,
              channel: agentV1Runtime.TransportChannel.DATA,
              connectionSessionToken: payloadToken,
            },
          },
        },
      ), { timeoutMs: this.context.timeoutMs });
      if (!channel.outboundReceiptMatches(outbound)) {
        throw failure('invalid_binding', 'data bind receipt is foreign');
      }
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    } finally {
      payloadToken.fill(0);
      token.fill(0);
      this.#token = undefined;
    }
    try {
      const body = await receiveFreshBody(channel);
      if (body.case !== 'attemptChannelBound') {
        throw unexpected(body.case, 'AttemptChannelBound');
      }
      assertExactDataBinding(body.value, this.context);
      this.#channel = undefined;
      return new HostBoundDataAttemptChannel(channel, this.context);
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    }
  }

  abort(cause?: unknown): void {
    this.#fail(cause ?? failure('invalid_binding', 'data bind was aborted'));
  }

  #requireChannel(): EstablishedAttemptChannel {
    if (!this.#channel || !this.#token) {
      throw failure('invalid_binding', 'data bind authority was consumed');
    }
    return this.#channel;
  }

  #fail(cause: unknown): void {
    this.#token?.fill(0);
    this.#token = undefined;
    this.#channel?.abort(cause);
    this.#channel = undefined;
  }
}

export class HostBoundDataAttemptChannel {
  #exchangeActive = false;
  constructor(
    private readonly channel: EstablishedAttemptChannel,
    readonly context: HostDataBoundContext,
  ) {}

  hydrate(request: HostDataHydrationRequest): Promise<HostDataHydrationReceipt> {
    return sendHostDataHydration(this, request);
  }

  async exchange(
    payload: agentV1Runtime.FramePayload,
  ): Promise<agentV1Runtime.FramePayload['body']> {
    if (this.#exchangeActive) {
      throw failure('invalid_hydration', 'data stop-and-wait window is occupied');
    }
    this.#exchangeActive = true;
    try {
      const outbound = await this.channel.sendNew(
        payload,
        { timeoutMs: this.context.timeoutMs },
      );
      if (!this.channel.outboundReceiptMatches(outbound)) {
        throw failure('invalid_hydration', 'data outbound receipt is foreign');
      }
      return await receiveFreshBody(this.channel);
    } catch (cause) {
      this.channel.abort(cause);
      throw cause;
    } finally {
      this.#exchangeActive = false;
    }
  }

  abort(cause?: unknown): void {
    this.channel.abort(cause);
  }

  get isFailed(): boolean {
    return this.channel.isPoisoned;
  }
}

export function createHostPendingDataAttemptChannel(
  provision: HostDataAttemptChannelProvision,
): HostPendingDataAttemptChannel {
  const context = validateHostDataProvision(provision);
  const binding = {};
  const correlations = new AttemptCorrelationAuthority(
    provision.maxIpcFrames,
  );
  const receiver = new AttemptFrameReceiver(mintNegotiatedSeed({
    protocolVersion: provision.protocolVersion,
    connectionId: provision.connectionId,
    runtimeInstanceId: provision.runtimeInstanceId,
    identity: provision.identity,
    channel: agentV1Runtime.TransportChannel.DATA,
    direction: 'runner_to_host',
    maximumFrameBytes: Number(context.limits.maxFrameBytes),
    streamWatermark: 0n,
    bootstrapMessageId: DATA_TOMBSTONE_ID,
    bootstrapBinding: binding,
  }), {
    replayCapacity: Math.min(DATA_REPLAY_ENTRIES, provision.maxIpcFrames),
    totalIdentityCapacity: provision.maxIpcFrames,
    maxReplayBytes: Number(context.limits.maxFrameBytes)
      * Math.min(DATA_REPLAY_ENTRIES, provision.maxIpcFrames),
  }, correlations);
  const sender = new OutboundHeaderAuthority({
    protocolVersion: provision.protocolVersion,
    connectionId: provision.connectionId,
    identity: provision.identity,
    channel: agentV1Runtime.TransportChannel.DATA,
    direction: 'host_to_runner',
    maximumFrameBytes: Number(context.limits.maxFrameBytes),
    committedStreamSeq: 0n,
    maximumResponseTimeoutMs: context.timeoutMs,
    hardDeadlineAtUnixMs: provision.hardDeadlineAtUnixMs,
    clock: provision.clock,
    correlations,
  });
  const owner = {};
  const established = handoffEstablishedAttemptChannel(
    provision.transport,
    receiver,
    sender,
    owner,
    provision.clock,
    provision.hardDeadlineAtUnixMs,
    context.timeoutMs,
    provision.failureObserver,
  );
  return new HostPendingDataAttemptChannel(
    established,
    provision.connectionSessionToken.slice(),
    context,
  );
}

async function receiveFreshBody(
  channel: EstablishedAttemptChannel,
): Promise<agentV1Runtime.FramePayload['body']> {
  for (;;) {
    const outcome = await channel.beginReceive();
    if (outcome.kind === 'replayed') continue;
    const pending = outcome.pending;
    const binding = pending.binding();
    const body = pending.takeBodyAndDigest().body;
    const receipt = channel.commitAccepted(pending);
    if (!channel.receiptMatches(receipt, binding)) {
      throw failure('unexpected_payload', 'data inbound receipt is foreign');
    }
    return body;
  }
}

function unexpected(
  actual: string | undefined,
  expected: string,
): HostDataChannelError {
  return failure(
    'unexpected_payload',
    `data channel expected ${expected}, received ${actual ?? 'missing'}`,
  );
}

function failure(
  code: ConstructorParameters<typeof HostDataChannelError>[0],
  message: string,
): HostDataChannelError {
  return new HostDataChannelError(code, message);
}
