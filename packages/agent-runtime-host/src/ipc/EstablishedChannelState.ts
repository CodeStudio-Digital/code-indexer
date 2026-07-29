import type { AuthorityClock } from './AttemptClock.js';
import { AttemptDeadlineGuard } from './AttemptDeadlineGuard.js';
import {
  type AttemptFrameReceiver,
  AttemptFrameReceiverError,
} from './AttemptFrameReceiver.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import {
  EstablishedAttemptChannelOutbound,
} from './EstablishedAttemptChannelOutbound.js';
import type { OutboundHeaderAuthority } from './OutboundHeaderAuthority.js';

export class EstablishedChannelState {
  readonly receiptBinding = {};
  #transport?: DelimitedByteChannel;
  #receiver?: AttemptFrameReceiver;
  #sender?: OutboundHeaderAuthority;
  #owner?: object;
  #clock?: AuthorityClock;
  #outbound?: EstablishedAttemptChannelOutbound;
  #deadlines?: AttemptDeadlineGuard;
  #activeOperation?: object;
  #failureObserver?: (cause: unknown) => void;
  #poisoned = false;

  constructor(
    transport: DelimitedByteChannel,
    receiver: AttemptFrameReceiver,
    sender: OutboundHeaderAuthority,
    owner: object,
    clock: AuthorityClock,
    hardDeadlineAtUnixMs: bigint,
    maximumPendingMs: number,
    failureObserver?: (cause: unknown) => void,
  ) {
    this.#transport = transport;
    this.#receiver = receiver;
    this.#sender = sender;
    this.#owner = owner;
    this.#clock = clock;
    this.#failureObserver = failureObserver;
    this.#outbound = new EstablishedAttemptChannelOutbound(
      transport,
      receiver,
      sender,
      owner,
      this.receiptBinding,
    );
    this.#deadlines = new AttemptDeadlineGuard(
      clock,
      hardDeadlineAtUnixMs,
      maximumPendingMs,
      (cause) => this.poison(cause),
    );
    this.#deadlines.start();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const token = this.#startOperation();
    try {
      return await operation();
    } catch (cause) {
      this.poison(cause);
      throw cause;
    } finally {
      this.#finishOperation(token);
    }
  }

  runSync<T>(operation: () => T): T {
    const token = this.#startOperation();
    try {
      return operation();
    } catch (cause) {
      this.poison(cause);
      throw cause;
    } finally {
      this.#finishOperation(token);
    }
  }

  poison(cause: unknown): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    this.#deadlines?.close();
    this.#receiver?.fail();
    this.#sender?.poison();
    try {
      this.#transport?.fail(cause, this.#owner);
    } finally {
      const observer = this.#failureObserver;
      this.#transport = undefined;
      this.#receiver = undefined;
      this.#sender = undefined;
      this.#owner = undefined;
      this.#clock = undefined;
      this.#outbound = undefined;
      this.#deadlines = undefined;
      this.#failureObserver = undefined;
      observer?.(cause);
    }
  }

  abort(cause: unknown = new AttemptFrameReceiverError(
      'receiver_poisoned',
      'established channel was aborted',
    )): void {
    this.poison(cause);
  }

  tick(): void {
    this.#deadlines?.tick();
  }

  armPending(deadlineAtUnixMs: bigint | undefined): void {
    this.#deadlines!.armPending(deadlineAtUnixMs);
  }

  clearPending(): void {
    this.#deadlines!.clearPending();
  }

  get isPoisoned(): boolean {
    return this.#poisoned;
  }

  get transport(): DelimitedByteChannel {
    return this.#require(this.#transport);
  }

  get receiver(): AttemptFrameReceiver {
    return this.#require(this.#receiver);
  }

  get outbound(): EstablishedAttemptChannelOutbound {
    return this.#require(this.#outbound);
  }

  get owner(): object {
    return this.#require(this.#owner);
  }

  get clock(): AuthorityClock {
    return this.#require(this.#clock);
  }

  #startOperation(): object {
    if (this.#poisoned) throw poisoned();
    this.#deadlines?.tick();
    if (this.#activeOperation) {
      const error = new AttemptFrameReceiverError(
        'pending_inbound_active',
        'another channel operation is still active',
      );
      this.poison(error);
      throw error;
    }
    const token = {};
    this.#activeOperation = token;
    return token;
  }

  #finishOperation(token: object): void {
    if (this.#activeOperation === token) this.#activeOperation = undefined;
  }

  #require<T>(value: T | undefined): T {
    if (value === undefined) throw poisoned();
    return value;
  }
}

function poisoned(): AttemptFrameReceiverError {
  return new AttemptFrameReceiverError(
    'receiver_poisoned',
    'established channel is poisoned',
  );
}
