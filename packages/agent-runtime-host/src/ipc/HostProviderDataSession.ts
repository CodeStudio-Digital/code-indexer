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
import { HostCapabilityReadBatch } from './HostCapabilityReadBatch.js';
import type { DurableEngineEventCommitPort } from './DurableEngineEventCommitPort.js';
import { commitEngineEventProposal } from './EngineEventCommitHandler.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';
import type { CapabilityGateway } from '../capability-gateway/CapabilityGateway.js';
import { ProviderStreamCredit } from './ProviderStreamCredit.js';
import { HostProviderRequestTransfer } from './HostProviderRequestTransfer.js';

export class HostProviderDataSession {
  readonly #lane = new ProviderDataOutboundLane();
  readonly #operations = new Set<Promise<void>>();
  readonly #credits = new Map<string, ProviderStreamCredit>();
  #retiredCredit?: ProviderStreamCredit;
  #running = false;
  #closed = false;
  #engineTerminalCommitted = false;
  #terminating = false;
  readonly #readBatch?: HostCapabilityReadBatch;
  readonly #requestTransfer: HostProviderRequestTransfer;

  constructor(
    private readonly channel: EstablishedAttemptChannel,
    readonly context: HostDataBoundContext,
    private readonly gateway: ProviderGateway,
    private readonly eventCommitter?: DurableEngineEventCommitPort,
    private readonly capabilityGateway?: CapabilityGateway,
  ) {
    this.#requestTransfer = new HostProviderRequestTransfer(channel, context, this.#lane);
    if (capabilityGateway) this.#readBatch = new HostCapabilityReadBatch(channel, context, this.#lane, capabilityGateway);
  }

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
        if (body.case === 'providerEventConsumed') {
          const credit = this.#credits.get(body.value.operationId)
            ?? (this.#retiredCredit?.operationId === body.value.operationId ? this.#retiredCredit : undefined);
          if (!credit) throw failure('provider consumption receipt has no active stream');
          const binding = pending.binding();
          const receipt = this.channel.commitAccepted(pending);
          if (!this.channel.receiptMatches(receipt, binding)) throw failure('provider consumption receipt is foreign');
          credit.acknowledge(body.value);
          continue;
        }
        if (body.case === 'providerRequestChunk' || body.case === 'providerRequestCommit') {
          this.#readBatch?.assertIdle();
          if (this.#engineTerminalCommitted || this.#terminating) throw failure('provider transfer follows termination');
          if (this.gateway.activeOperationCount !== 0) throw failure('provider transfer overlaps an active stream');
          if (body.case === 'providerRequestChunk') {
            await this.#requestTransfer.receiveChunk(pending, body.value, payloadDigest);
          } else {
            const start = this.#requestTransfer.finish(body.value, pending.header().deadlineAtUnixMs);
            if (body.value.checkpointOnly) {
              await this.#requestTransfer.checkpoint(pending, start, payloadDigest, this.gateway, this.eventCommitter);
            } else {
              await this.#startProvider(pending, start, payloadDigest);
            }
          }
          continue;
        }
        if (this.#requestTransfer.pending) throw failure('provider transfer interrupted by another operation');
        if (body.case === 'providerCheckpoint') {
          this.#readBatch?.assertIdle();
          if (this.#engineTerminalCommitted) throw failure('checkpoint follows terminal');
          await this.#requestTransfer.checkpoint(pending, body.value, payloadDigest, this.gateway, this.eventCommitter);
          continue;
        }
        if (body.case === 'providerStart') {
          this.#readBatch?.assertIdle();
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
          await this.capabilityGateway?.retireCommitted(body.value.record!);
          if (body.value.record?.body.case === 'terminal') {
            this.#engineTerminalCommitted = true;
          }
          continue;
        }
        if (body.case === 'capabilityPrepare' && this.capabilityGateway) {
          this.#readBatch?.assertIdle();
          await this.#prepareCapability(pending, body.value);
          continue;
        }
        if (body.case === 'capabilityExecute' && this.capabilityGateway) {
          this.#readBatch?.assertIdle();
          await this.#executeCapability(pending, body.value);
          continue;
        }
        if (body.case === 'capabilityReadBatchExecute' && this.#readBatch) {
          const { settled } = await this.#readBatch.start(pending, body.value);
          const tracked = settled.catch((cause) => this.abort(cause)).finally(() => this.#operations.delete(tracked));
          this.#operations.add(tracked);
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
      this.#requestTransfer.clear();
      signal?.removeEventListener('abort', abort);
    }
  }

  abort(cause?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#requestTransfer.clear();
    for (const credit of this.#credits.values()) credit.close(cause ?? failure('provider Data session was aborted'));
    this.#credits.clear();
    this.#retiredCredit = undefined;
    try {
      this.gateway.fenceAttempt(this.context.identity);
    } finally {
      this.channel.abort(cause ?? failure('provider Data session was aborted'));
    }
  }

  /** Authorizes Data EOF caused by an already-dispatched Control termination. */
  beginTermination(): void {
    this.#terminating = true;
    this.#requestTransfer.clear();
  }

  get activeOperationCount(): number {
    return this.#operations.size;
  }

  async #startProvider(
    pending: Parameters<EstablishedAttemptChannel['commitAccepted']>[0],
    start: agentV1Runtime.ProviderStart,
    payloadDigest: Uint8Array,
  ): Promise<void> {
    if (this.#engineTerminalCommitted || this.#terminating) throw failure('provider start follows termination');
    if (this.#credits.has(start.operationId)) throw failure('provider operation already owns consumption credit');
    const credit = start.consumptionAckRequired ? new ProviderStreamCredit(start.operationId) : undefined;
    if (credit) this.#credits.set(start.operationId, credit);
    const sink = new ProviderDataEventSink(
      this.channel,
      pending,
      this.context,
      this.#lane,
      start.operationId,
      credit,
    );
    const operation = this.gateway.run(start, payloadDigest, sink,
      this.eventCommitter?.commitProviderFrontier?.bind(this.eventCommitter));
    const tracked = operation
      .catch((cause) => { this.abort(cause); })
      .finally(() => {
        this.#operations.delete(tracked);
        if (credit) { this.#credits.delete(start.operationId); this.#retiredCredit = credit; }
      });
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
    await this.#commitCapabilityResponse(pending, {
      case: 'capabilityUpdate', value: await this.capabilityGateway!.prepare(prepare),
    });
  }

  async #executeCapability(
    pending: Parameters<EstablishedAttemptChannel['commitAccepted']>[0],
    execute: agentV1Capability.CapabilityExecute,
  ): Promise<void> {
    await this.#commitCapabilityResponse(pending, {
      case: 'capabilityExecutionResult', value: await this.capabilityGateway!.execute(execute),
    });
  }

  async #commitCapabilityResponse(
    pending: Parameters<EstablishedAttemptChannel['commitAccepted']>[0],
    body: agentV1Runtime.FramePayload['body'],
  ): Promise<void> {
    await this.#lane.run(async () => {
      const binding = pending.binding();
      const receipt = await this.channel.commitResponse(pending,
        create(agentV1Runtime.FramePayloadSchema, { body }), { timeoutMs: this.context.timeoutMs });
      if (!this.channel.receiptMatches(receipt, binding)) throw failure('capability receipt is foreign');
    });
  }
}

function failure(message: string): HostDataChannelError {
  return new HostDataChannelError('provider_failure', message);
}
