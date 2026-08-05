import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type {
  CommittedOutbound,
  EstablishedAttemptChannel,
  InboundBinding,
  PendingInbound,
} from '../ipc/EstablishedAttemptChannel.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647n;
const MAX_INT64 = (1n << 63n) - 1n;

interface PendingCommandAck {
  readonly promise: Promise<string>;
  readonly resolve: (replyToMessageId: string) => void;
  readonly reject: (cause: unknown) => void;
  readonly deadlineAtUnixMs: bigint;
  timer?: NodeJS.Timeout;
}

export class HostActiveCommandAck {
  #pending?: PendingCommandAck;

  constructor(
    private readonly channel: EstablishedAttemptChannel,
    private readonly clock: AuthorityClock,
    private readonly stopMonitor: () => void,
    private readonly failOwner: (cause: unknown) => void,
  ) {}

  async sendAndAwait(
    send: () => Promise<CommittedOutbound>,
    timeoutMs: number,
  ): Promise<void> {
    if (this.#pending) throw invalidOrder();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new HostLifecycleDriverError(
        'driver_failed',
        'active command timeout must be a positive safe integer',
      );
    }
    const pending = this.#create(BigInt(timeoutMs));
    this.#pending = pending;
    this.#arm(pending, this.clock.now());
    try {
      const outbound = await send();
      const replyToMessageId = await pending.promise;
      if (replyToMessageId !== outbound.outboundMessageId()) {
        throw new HostLifecycleDriverError(
          'invalid_channel_receipt',
          'command Ack is not bound to its outbound request',
        );
      }
    } catch (cause) {
      this.#clear(pending);
      throw cause;
    }
  }

  accept(
    pendingInbound: PendingInbound,
    binding: InboundBinding,
    replyToMessageId: string | undefined,
  ): void {
    const pending = this.#pending;
    if (!pending) throw invalidOrder();
    if (!replyToMessageId) {
      throw new HostLifecycleDriverError(
        'invalid_channel_receipt',
        'command Ack is missing reply_to',
      );
    }
    const receipt = this.channel.commitAccepted(pendingInbound);
    if (!this.channel.receiptMatches(receipt, binding)) {
      throw new HostLifecycleDriverError(
        'invalid_channel_receipt',
        'command Ack commit receipt is not bound to its inbound frame',
      );
    }
    this.#clear(pending);
    this.stopMonitor();
    pending.resolve(replyToMessageId);
  }

  tick(): void {
    if (this.#pending) this.#arm(this.#pending, this.clock.now());
  }

  close(cause: unknown): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#clear(pending);
    pending.reject(cause);
  }

  get isPending(): boolean {
    return this.#pending !== undefined;
  }

  #create(timeoutMs: bigint): PendingCommandAck {
    let resolve!: (replyToMessageId: string) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<string>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const now = this.clock.now();
    return {
      promise,
      resolve,
      reject,
      deadlineAtUnixMs: now > MAX_INT64 - timeoutMs
        ? MAX_INT64
        : now + timeoutMs,
    };
  }

  #arm(pending: PendingCommandAck, now: bigint): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (now >= pending.deadlineAtUnixMs) {
      throw commandTimeout(pending.deadlineAtUnixMs, now);
    }
    const remaining = pending.deadlineAtUnixMs - now;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      try {
        this.#arm(pending, this.clock.now());
      } catch (cause) {
        this.failOwner(cause);
      }
    }, Math.max(Number(
      remaining < MAX_TIMER_DELAY_MS ? remaining : MAX_TIMER_DELAY_MS,
    ), 1));
    pending.timer.unref();
  }

  #clear(pending: PendingCommandAck): void {
    if (this.#pending === pending) this.#pending = undefined;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
  }
}

function invalidOrder(): HostLifecycleDriverError {
  return new HostLifecycleDriverError(
    'invalid_order',
    'active control monitor cannot start or accept another command',
  );
}

function commandTimeout(
  deadline: bigint,
  observed: bigint,
): HostLifecycleDriverError {
  return new HostLifecycleDriverError(
    'command_ack_timeout',
    `active command Ack deadline ${deadline} expired at ${observed}`,
  );
}
