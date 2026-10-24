import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type {
  ProviderGatewayEvent,
  ProviderGatewayEventSinkPort,
} from '../provider-gateway/ProviderGatewayTypes.js';
import type { EstablishedAttemptChannel } from './EstablishedAttemptChannel.js';
import type { PendingInbound } from './AttemptFrameReceiver.js';
import { HostDataChannelError } from './HostDataChannelError.js';
import type { HostDataBoundContext } from './HostDataAttemptChannelValidation.js';
import type { ProviderDataOutboundLane } from './ProviderDataOutboundLane.js';
import type { ProviderStreamCredit } from './ProviderStreamCredit.js';

export class ProviderDataEventSink implements ProviderGatewayEventSinkPort {
  readonly #accepted: Promise<void>;
  #resolveAccepted!: () => void;
  #rejectAccepted!: (cause: unknown) => void;
  #phase: 'waiting' | 'streaming' | 'terminal' | 'failed' = 'waiting';

  constructor(
    private readonly channel: EstablishedAttemptChannel,
    private readonly pending: PendingInbound,
    private readonly context: HostDataBoundContext,
    private readonly lane: ProviderDataOutboundLane,
    private readonly operationId: string,
    private readonly credit?: ProviderStreamCredit,
  ) {
    this.#accepted = new Promise<void>((resolve, reject) => {
      this.#resolveAccepted = resolve;
      this.#rejectAccepted = reject;
    });
  }

  waitAccepted(): Promise<void> {
    return this.#accepted;
  }

  async emit(event: ProviderGatewayEvent, signal?: AbortSignal): Promise<void> {
    const waitConsumed = event.case !== 'providerAccepted' && event.case !== 'providerTerminal'
      ? this.credit?.reserve(event.value.eventSequence) : undefined;
    try {
      await this.lane.run(async () => {
        if (this.#phase === 'waiting') {
          await this.#commitAccepted(event);
          return;
        }
        if (this.#phase !== 'streaming' || event.case === 'providerAccepted') {
          throw failure('provider event violates operation ordering');
        }
        if (event.value.operationId !== this.operationId) {
          throw failure('provider event operation identity diverges');
        }
        const payload = create(agentV1Runtime.FramePayloadSchema, { body: event });
        const receipt = await this.channel.sendEvent(
          payload,
          { timeoutMs: this.context.timeoutMs },
        );
        if (!this.channel.outboundReceiptMatches(receipt)) {
          throw failure('provider event receipt is foreign');
        }
        if (event.case === 'providerTerminal') this.#phase = 'terminal';
      });
      if (waitConsumed) await waitConsumed(signal);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      this.credit?.close(cause);
      this.#phase = 'failed';
      this.#rejectAccepted(cause);
      throw cause;
    }
  }

  async #commitAccepted(event: ProviderGatewayEvent): Promise<void> {
    if (
      event.case !== 'providerAccepted'
      || event.value.operationId !== this.operationId
      || event.value.runtimeInstanceId !== this.context.runtimeInstanceId
    ) throw failure('ProviderAccepted does not match its Data authority');
    const binding = this.pending.binding();
    const payload = create(agentV1Runtime.FramePayloadSchema, { body: event });
    const receipt = await this.channel.commitResponse(
      this.pending,
      payload,
      { timeoutMs: this.context.timeoutMs },
    );
    if (!this.channel.receiptMatches(receipt, binding)) {
      throw failure('ProviderAccepted receipt is foreign');
    }
    this.#phase = 'streaming';
    this.#resolveAccepted();
  }
}

function failure(message: string): HostDataChannelError {
  return new HostDataChannelError('provider_failure', message);
}
