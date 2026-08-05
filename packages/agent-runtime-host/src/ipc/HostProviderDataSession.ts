import { create } from '@bufbuild/protobuf';
import {
  agentV1Runtime,
  type agentV1Capability,
} from '@mcp/agent-runtime-contracts';
import type { ProviderGateway } from '../provider-gateway/ProviderGateway.js';
import type { EstablishedAttemptChannel } from './EstablishedAttemptChannel.js';
import { HostDataChannelError } from './HostDataChannelError.js';
import type { HostDataBoundContext } from './HostDataAttemptChannelValidation.js';
import { ProviderDataEventSink } from './ProviderDataEventSink.js';
import { ProviderDataOutboundLane } from './ProviderDataOutboundLane.js';
import type { DurableEngineEventCommitPort } from './DurableEngineEventCommitPort.js';
import { commitEngineEventProposal } from './EngineEventCommitHandler.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';
import type { CapabilityGateway } from '../capability-gateway/CapabilityGateway.js';

export class HostProviderDataSession {
  readonly #lane = new ProviderDataOutboundLane();
  readonly #operations = new Set<Promise<void>>();
  #running = false;
  #closed = false;
  #engineTerminalCommitted = false;
  #terminating = false;

  constructor(
    private readonly channel: EstablishedAttemptChannel,
    readonly context: HostDataBoundContext,
    private readonly gateway: ProviderGateway,
    private readonly eventCommitter?: DurableEngineEventCommitPort,
    private readonly capabilityGateway?: CapabilityGateway,
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    if (this.#running) throw failure('provider Data session is single-use');
    this.#running = true;
    const abort = () => this.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        const outcome = await this.channel.beginReceive();
        if (outcome.kind === 'replayed') continue;
        const pending = outcome.pending;
        const { body, payloadDigest } = pending.takeBodyAndDigest();
        if (body.case === 'providerStart') {
          await this.#startProvider(pending, body.value, payloadDigest);
          continue;
        }
        if (body.case === 'providerCancel') {
          const binding = pending.binding();
          const receipt = this.channel.commitAccepted(pending);
          if (!this.channel.receiptMatches(receipt, binding)) {
            throw failure('ProviderCancel receipt is foreign');
          }
          this.gateway.cancel(body.value);
          continue;
        }
        if (body.case === 'engineEventProposal' && this.eventCommitter) {
          await commitEngineEventProposal(
            this.channel,
            pending,
            body.value,
            this.context,
            this.#lane,
            this.eventCommitter,
          );
          if (body.value.record?.body.case === 'terminal') {
            this.#engineTerminalCommitted = true;
          }
          continue;
        }
        if (body.case === 'capabilityPrepare' && this.capabilityGateway) {
          await this.#prepareCapability(pending, body.value);
          continue;
        }
        this.channel.reject(pending);
      }
    } catch (cause) {
      if (signal?.aborted && this.#closed) return;
      // Once Control termination is dispatched, Data teardown is subordinate
      // to the Control ACK. Do not let any transport-close shape revoke the
      // sibling channel while that acknowledgement is in flight.
      if (this.#terminating) return;
      if (
        this.#engineTerminalCommitted
        && cause instanceof AttemptFrameReceiverError
        && cause.code === 'unexpected_eof'
      ) return;
      this.abort(cause);
      throw cause;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  abort(cause?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.gateway.fenceAttempt(this.context.identity);
    } finally {
      this.channel.abort(cause ?? failure('provider Data session was aborted'));
    }
  }

  /** Authorizes Data EOF caused by an already-dispatched Control termination. */
  beginTermination(): void {
    this.#terminating = true;
  }

  get activeOperationCount(): number {
    return this.#operations.size;
  }

  async #startProvider(
    pending: Parameters<EstablishedAttemptChannel['commitAccepted']>[0],
    start: agentV1Runtime.ProviderStart,
    payloadDigest: Uint8Array,
  ): Promise<void> {
    const sink = new ProviderDataEventSink(
      this.channel,
      pending,
      this.context,
      this.#lane,
      start.operationId,
    );
    const operation = this.gateway.run(start, payloadDigest, sink);
    const tracked = operation
      .catch((cause) => { this.abort(cause); })
      .finally(() => { this.#operations.delete(tracked); });
    this.#operations.add(tracked);
    await Promise.race([
      sink.waitAccepted(),
      operation.then(() => {
        throw failure('provider operation ended before ProviderAccepted');
      }),
    ]);
  }

  async #prepareCapability(
    pending: Parameters<EstablishedAttemptChannel['commitAccepted']>[0],
    prepare: agentV1Capability.CapabilityPrepare,
  ): Promise<void> {
    const update = await this.capabilityGateway!.prepare(prepare);
    await this.#lane.run(async () => {
      const binding = pending.binding();
      const response = create(agentV1Runtime.FramePayloadSchema, {
        body: { case: 'capabilityUpdate', value: update },
      });
      const receipt = await this.channel.commitResponse(
        pending,
        response,
        { timeoutMs: this.context.timeoutMs },
      );
      if (!this.channel.receiptMatches(receipt, binding)) {
        throw failure('CapabilityUpdate receipt is foreign');
      }
    });
  }
}

function failure(message: string): HostDataChannelError {
  return new HostDataChannelError('provider_failure', message);
}
