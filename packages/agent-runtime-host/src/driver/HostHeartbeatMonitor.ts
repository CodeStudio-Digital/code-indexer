import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type {
  EstablishedAttemptChannel,
  PendingInbound,
} from '../ipc/EstablishedAttemptChannel.js';
import { HostActiveCommandAck } from './HostActiveCommandAck.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import { validateHeartbeat } from './HostHeartbeatValidation.js';
import type {
  ActiveAttemptAuthorityFacts,
  HostHeartbeatSnapshot,
} from './HostLifecycleTypes.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647n;
const MAX_INT64 = (1n << 63n) - 1n;

export class HostHeartbeatMonitor {
  #timer?: NodeJS.Timeout;
  #deadline?: bigint;
  #snapshot?: HostHeartbeatSnapshot;
  readonly #commandAck: HostActiveCommandAck;
  #running = false;

  constructor(
    private readonly channel: EstablishedAttemptChannel,
    private readonly authority: ActiveAttemptAuthorityFacts,
    private readonly timeoutMs: bigint,
    private readonly clock: AuthorityClock,
    private readonly failOwner: (cause: unknown) => void,
  ) {
    this.#commandAck = new HostActiveCommandAck(
      channel,
      clock,
      () => this.#stopAfterCommand(),
      failOwner,
    );
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#armFrom(this.clock.now());
    void this.#pump().catch((cause: unknown) => this.#fail(cause));
  }

  tick(): void {
    if (!this.#running) return;
    const now = this.clock.now();
    if (this.#deadline !== undefined) this.#arm(this.#deadline, now);
    this.#commandAck.tick();
  }

  close(cause: unknown = new HostLifecycleDriverError(
    'driver_failed',
    'active control monitor closed before command acknowledgement',
  )): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#deadline = undefined;
    this.#commandAck.close(cause);
  }

  inspect(): HostHeartbeatSnapshot | undefined {
    const value = this.#snapshot;
    return value && Object.freeze({
      ...value,
      resources: { ...value.resources },
    });
  }

  async sendAndAwaitAck(
    send: Parameters<HostActiveCommandAck['sendAndAwait']>[0],
    timeoutMs: number,
  ): Promise<void> {
    if (!this.#running) {
      throw new HostLifecycleDriverError(
        'invalid_order',
        'active control monitor is not running',
      );
    }
    return this.#commandAck.sendAndAwait(send, timeoutMs);
  }

  async #pump(): Promise<void> {
    while (this.#running) {
      const outcome = await this.channel.beginReceive();
      if (!this.#running) return;
      if (outcome.kind === 'replayed') continue;
      this.#accept(outcome.pending);
    }
  }

  #accept(pending: PendingInbound): void {
    const header = pending.header();
    const binding = pending.binding();
    const body = pending.takeBodyAndDigest().body;
    if (body.case === 'ack' && this.#commandAck.isPending) {
      this.#commandAck.accept(pending, binding, header.replyToMessageId);
      return;
    }
    if (body.case !== 'heartbeat') {
      this.#reject(pending);
      throw new HostLifecycleDriverError(
        'unexpected_payload',
        `active lifecycle received unexpected payload ${body.case ?? 'missing'}`,
      );
    }
    const observedAtUnixMs = this.clock.now();
    if (this.#deadline === undefined || observedAtUnixMs >= this.#deadline) {
      this.#reject(pending);
      throw timeout(this.#deadline ?? observedAtUnixMs, observedAtUnixMs);
    }
    let snapshot: HostHeartbeatSnapshot;
    try {
      snapshot = validateHeartbeat(
        body.value,
        header.messageId,
        header.sentAtUnixMs,
        observedAtUnixMs,
        this.authority,
        this.#snapshot,
      );
    } catch (cause) {
      this.#reject(pending);
      throw cause;
    }
    const receipt = this.channel.commitAccepted(pending);
    if (!this.channel.receiptMatches(receipt, binding)) {
      throw new HostLifecycleDriverError(
        'invalid_channel_receipt',
        'Heartbeat commit receipt is not bound to its inbound frame',
      );
    }
    this.#snapshot = snapshot;
    this.#armFrom(observedAtUnixMs);
  }

  #reject(pending: PendingInbound): void {
    try {
      this.channel.reject(pending);
    } catch {
      // Expected: rejection poisons the shared owner.
    }
  }

  #armFrom(observedAtUnixMs: bigint): void {
    const deadline = observedAtUnixMs > MAX_INT64 - this.timeoutMs
      ? MAX_INT64
      : observedAtUnixMs + this.timeoutMs;
    this.#arm(deadline, observedAtUnixMs);
  }

  #arm(deadline: bigint, observedAtUnixMs: bigint): void {
    if (!this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#deadline = deadline;
    if (observedAtUnixMs >= deadline) throw timeout(deadline, observedAtUnixMs);
    const remaining = deadline - observedAtUnixMs;
    const delay = Number(remaining < MAX_TIMER_DELAY_MS
      ? remaining
      : MAX_TIMER_DELAY_MS);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.tick();
      } catch (cause) {
        this.#fail(cause);
      }
    }, Math.max(delay, 1));
    this.#timer.unref();
  }

  #stopAfterCommand(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#deadline = undefined;
  }

  #fail(cause: unknown): void {
    if (!this.#running) return;
    this.close(cause);
    this.failOwner(cause);
  }
}

function timeout(deadline: bigint, observed: bigint): HostLifecycleDriverError {
  return new HostLifecycleDriverError(
    'heartbeat_timeout',
    `semantic heartbeat deadline ${deadline} expired at ${observed}`,
  );
}
