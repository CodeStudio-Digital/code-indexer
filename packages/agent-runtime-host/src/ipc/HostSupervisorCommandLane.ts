import type { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { authorityCommandBody } from './HostSupervisorAuthorityCommand.js';
import type { HostAuthorityRenewalRequest } from '../driver/HostLifecycleTypes.js';
import type {
  HostCancelAttemptRequest,
  HostFenceAttemptRequest,
  HostReapAttemptRequest,
} from '../driver/HostLifecycleTypes.js';
import { HostSupervisorFactError } from '../driver/HostSupervisorFactError.js';
import type { HostSupervisorFactHandoff } from '../driver/HostSupervisorFactTypes.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import type {
  PreparedSupervisorAcknowledgement,
} from './HostSupervisorAckAuthority.js';
import { HostSupervisorAckAuthority } from './HostSupervisorAckAuthority.js';
import type { PendingSupervisorFact } from './HostSupervisorFactChannelTypes.js';
import {
  cancelCommandBody,
  fenceCommandBody,
  reapCommandBody,
  validateSupervisorCommandAck,
} from './HostSupervisorCommandValidation.js';
import type {
  HostSupervisorCommandCase,
  PendingSupervisorCommand,
  SupervisorCommandBody,
} from './HostSupervisorCommandTypes.js';

export class HostSupervisorCommandLane {
  readonly #authority: HostSupervisorAckAuthority;
  #pending?: PendingSupervisorCommand;
  #commandReserved = false;
  #outboundIdle: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: DelimitedByteChannel,
    private readonly owner: object,
    private readonly handoff: HostSupervisorFactHandoff,
    private readonly nowUnixMs: () => bigint,
    private readonly poison: (cause: HostSupervisorFactError) => void,
  ) {
    this.#authority = new HostSupervisorAckAuthority(handoff, nowUnixMs);
  }

  acknowledge(
    pending: PendingSupervisorFact,
    reserve: (prepared: PreparedSupervisorAcknowledgement) => void,
  ): Promise<void> {
    return this.#runOutbound(async () => {
      const prepared = this.#authority.prepare(pending);
      reserve(prepared);
      await this.transport.send(prepared.encoded, this.owner);
      this.#authority.commit(prepared);
    });
  }

  maximumAcknowledgementBytes(pending: PendingSupervisorFact): number {
    return this.#authority.maximumEncodedBytes(pending);
  }

  replay(encoded: Uint8Array): Promise<void> {
    return this.#runOutbound(() => this.transport.send(encoded, this.owner));
  }

  cancel(request: HostCancelAttemptRequest, timeoutMs: number): Promise<void> {
    const command = cancelCommandBody(this.handoff, request, this.nowUnixMs());
    return this.#send(command.body, command.deadlineAtUnixMs, timeoutMs);
  }

  renewAuthority(request: HostAuthorityRenewalRequest, timeoutMs: number): Promise<void> {
    const command = authorityCommandBody(this.handoff, request, this.nowUnixMs());
    return this.#send(command.body, command.deadlineAtUnixMs, timeoutMs);
  }

  fence(request: HostFenceAttemptRequest, timeoutMs: number): Promise<void> {
    const command = fenceCommandBody(this.handoff, request, this.nowUnixMs());
    return this.#send(command.body, command.deadlineAtUnixMs, timeoutMs);
  }

  reap(request: HostReapAttemptRequest, timeoutMs: number): Promise<void> {
    const command = reapCommandBody(this.handoff, request, this.nowUnixMs());
    return this.#send(command.body, command.deadlineAtUnixMs, timeoutMs);
  }

  async acceptAcknowledgement(
    header: agentV1Supervisor.ManagementFrameHeader,
    acknowledgement: agentV1Supervisor.ManagementAck,
    observedAtUnixMs: bigint,
  ): Promise<HostSupervisorCommandCase> {
    await this.#outboundIdle;
    const pending = this.#pending;
    if (!pending) throw invalid('unsolicited management command ACK');
    validateSupervisorCommandAck(header, acknowledgement, pending, observedAtUnixMs);
    this.#completePending();
    return pending.case;
  }

  abort(cause: unknown): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#clearPending();
    pending.reject(cause);
  }

  async #send(
    body: SupervisorCommandBody,
    deadlineAtUnixMs: bigint,
    timeoutMs: number,
  ): Promise<void> {
    if (this.#commandReserved) throw invalid('a management command is already pending');
    this.#commandReserved = true;
    let completion: Promise<void> | undefined;
    try {
      await this.#runOutbound(async () => {
        const prepared = this.#authority.prepareCommand(body, deadlineAtUnixMs);
        const pending = deferred(prepared);
        this.#pending = pending;
        completion = pending.completion;
        await this.transport.send(prepared.encoded, this.owner);
        this.#authority.commitCommand(prepared);
        const remaining = deadlineAtUnixMs - this.nowUnixMs();
        const delay = Number(remaining < BigInt(timeoutMs) ? remaining : BigInt(timeoutMs));
        if (!Number.isSafeInteger(delay) || delay <= 0) throw timeoutFailure();
        if (this.#pending === pending) {
          pending.timer = setTimeout(() => this.#timeout(pending), delay);
          pending.timer.unref();
        }
      });
      await completion!;
    } catch (cause) {
      const failure = cause instanceof HostSupervisorFactError
        ? cause
        : new HostSupervisorFactError('transport_failure', 'management command failed', { cause });
      this.abort(failure);
      this.poison(failure);
      throw failure;
    }
  }

  async #runOutbound<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#outboundIdle;
    let release!: () => void;
    this.#outboundIdle = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #timeout(pending: PendingSupervisorCommand): void {
    if (this.#pending !== pending) return;
    const failure = timeoutFailure();
    this.abort(failure);
    this.poison(failure);
  }

  #completePending(): void {
    const pending = this.#pending!;
    this.#clearPending();
    pending.resolve();
  }

  #clearPending(): void {
    if (this.#pending?.timer) clearTimeout(this.#pending.timer);
    this.#pending = undefined;
    this.#commandReserved = false;
  }
}

function deferred(
  prepared: ReturnType<HostSupervisorAckAuthority['prepareCommand']>,
): PendingSupervisorCommand {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const completion = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { ...prepared, completion, resolve, reject };
}

function invalid(message: string): HostSupervisorFactError {
  return new HostSupervisorFactError('invalid_command', message);
}

function timeoutFailure(): HostSupervisorFactError {
  return new HostSupervisorFactError(
    'command_ack_timeout',
    'management command ACK exceeded its deadline',
  );
}
