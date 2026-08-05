import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { AuthorityClock } from './AttemptClock.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import type { EstablishedAttemptChannel } from './EstablishedAttemptChannel.js';
import {
  type HostDataBoundContext,
  assertExactDataBinding,
} from './HostDataAttemptChannelValidation.js';
import { HostDataChannelError } from './HostDataChannelError.js';
import type {
  HostDataHydrationRequest,
  HostDataHydrationReceipt,
} from './HostDataHydration.js';
import { sendHostDataHydration } from './HostDataHydration.js';
import { HostProviderDataSession } from './HostProviderDataSession.js';
import type { ProviderGateway } from '../provider-gateway/ProviderGateway.js';
import { constructHostDataAttemptChannel } from './HostDataAttemptChannelConstruction.js';
import type { DurableEngineEventCommitPort } from './DurableEngineEventCommitPort.js';
import type { CapabilityGateway } from '../capability-gateway/CapabilityGateway.js';
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
  #phase: 'bound' | 'hydrating' | 'hydrated' | 'handed_off' | 'failed' = 'bound';
  constructor(
    private channel: EstablishedAttemptChannel | undefined,
    readonly context: HostDataBoundContext,
  ) {}

  async hydrate(request: HostDataHydrationRequest): Promise<HostDataHydrationReceipt> {
    if (this.#phase !== 'bound') {
      throw failure('invalid_hydration', 'data hydration is single-use');
    }
    this.#phase = 'hydrating';
    try {
      const receipt = await sendHostDataHydration(this, request);
      this.#phase = 'hydrated';
      return receipt;
    } catch (cause) {
      this.#phase = 'failed';
      throw cause;
    }
  }

  intoProviderSession(
    gateway: ProviderGateway,
    eventCommitter?: DurableEngineEventCommitPort,
    capabilityGateway?: CapabilityGateway,
  ): HostProviderDataSession {
    if (this.#phase !== 'hydrated' || !this.channel) {
      throw failure('provider_failure', 'provider session requires committed hydration');
    }
    const channel = this.channel;
    this.channel = undefined;
    this.#phase = 'handed_off';
    return new HostProviderDataSession(
      channel,
      this.context,
      gateway,
      eventCommitter,
      capabilityGateway,
    );
  }

  async exchange(
    payload: agentV1Runtime.FramePayload,
  ): Promise<agentV1Runtime.FramePayload['body']> {
    if (this.#exchangeActive) {
      throw failure('invalid_hydration', 'data stop-and-wait window is occupied');
    }
    this.#exchangeActive = true;
    try {
      const channel = this.#requireChannel();
      const outbound = await channel.sendNew(
        payload,
        { timeoutMs: this.context.timeoutMs },
      );
      if (!channel.outboundReceiptMatches(outbound)) {
        throw failure('invalid_hydration', 'data outbound receipt is foreign');
      }
      return await receiveFreshBody(channel);
    } catch (cause) {
      this.#phase = 'failed';
      this.channel?.abort(cause);
      throw cause;
    } finally {
      this.#exchangeActive = false;
    }
  }

  abort(cause?: unknown): void {
    this.#phase = 'failed';
    this.channel?.abort(cause);
    this.channel = undefined;
  }

  get isFailed(): boolean {
    return this.#phase === 'failed' || this.channel?.isPoisoned === true;
  }

  #requireChannel(): EstablishedAttemptChannel {
    if (!this.channel || this.#phase === 'handed_off' || this.#phase === 'failed') {
      throw failure('provider_failure', 'data channel ownership is unavailable');
    }
    return this.channel;
  }
}

export function createHostPendingDataAttemptChannel(
  provision: HostDataAttemptChannelProvision,
): HostPendingDataAttemptChannel {
  const constructed = constructHostDataAttemptChannel(provision);
  return new HostPendingDataAttemptChannel(
    constructed.channel,
    provision.connectionSessionToken.slice(),
    constructed.context,
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
