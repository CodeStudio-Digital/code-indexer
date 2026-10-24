import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { AttemptRuntimeLease } from '../facade/OwnedAttemptAdapter.js';
import type { CancelReason } from '../facade/types.js';
import type { ActiveAttemptAuthorityHandle } from '../driver/HostLifecycleReceipts.js';
import type { NativeRustHostAttemptRuntime } from './NativeRustHostAttemptRuntime.js';
import { createAuthorityClock, type AuthorityClock } from '../ipc/AttemptClock.js';

export type NativeAttemptLifecycle = Pick<NativeRustHostAttemptRuntime,
  'waitForTerminal' | 'waitForPhysicalReap' | 'cancelActive' | 'close'>
  & Partial<Pick<NativeRustHostAttemptRuntime, 'renewAuthority'>>;

export interface NativeCancellationBudget {
  readonly deadlineAtUnixMs: bigint;
  readonly cancelGraceMs: bigint;
}

/** Owns cleanup after normal completion as well as interruption. User cancel
 * resolves on the Control ACK; closed resolves only after the physical reap. */
export class NativeAttemptLease implements AttemptRuntimeLease {
  private resolveClosed!: () => void;
  private rejectClosed!: (cause: unknown) => void;
  readonly closed = new Promise<void>((resolve, reject) => {
    this.resolveClosed = resolve; this.rejectClosed = reject;
  });
  private cancellation?: Promise<void>;
  private shutdown?: Promise<void>;
  private readonly cancellationBudget: NativeCancellationBudget;

  constructor(private readonly runtime: NativeAttemptLifecycle,
    private readonly authority: ActiveAttemptAuthorityHandle, private readonly attemptId: string,
    cancellationBudget: NativeCancellationBudget, private readonly clock: AuthorityClock = createAuthorityClock()) {
    if (cancellationBudget.cancelGraceMs <= 0n || cancellationBudget.deadlineAtUnixMs <= 0n) {
      throw new Error('Native cancellation requires a sealed positive budget');
    }
    this.cancellationBudget = { ...cancellationBudget };
    void this.closed.catch(() => undefined);
    void Promise.race([
      runtime.waitForTerminal(),
      runtime.waitForPhysicalReap().then(() => { throw new Error('native process exited before terminal ACK'); }),
    ]).then(() => this.cancel({ code: 'terminal_cleanup' }), (cause) => {
      if (!this.cancellation) this.finish(cause);
    }).catch((cause) => this.finish(cause));
  }

  cancel(reason: CancelReason): Promise<void> {
    if (this.cancellation) return this.cancellation;
    if (this.shutdown) return this.closed;
    this.cancellation = Promise.resolve().then(() => {
      const now = this.clock.now();
      const { deadlineAtUnixMs, cancelGraceMs } = this.cancellationBudget;
      if (deadlineAtUnixMs <= now) throw new Error('Native cancellation authority expired; closing owned processes');
      const grace = cancelGraceMs < 750n ? cancelGraceMs : 750n;
      return this.runtime.cancelActive(this.authority, {
        reason: reason.code === 'terminal_cleanup' ? agentV1Runtime.CancelReason.HOST_SHUTDOWN
          : agentV1Runtime.CancelReason.USER_REQUEST,
        reasonCode: reason.code.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128) || 'cancelled',
        graceDeadlineAtUnixMs: now + grace < deadlineAtUnixMs ? now + grace : deadlineAtUnixMs,
        idempotencyKey: `native-lease-cancel:${this.attemptId}`,
      });
    });
    void this.cancellation.then(() => this.runtime.waitForPhysicalReap())
      .then(() => this.finish(), (cause) => this.finish(cause));
    return this.cancellation;
  }

  async renewAuthority(request: import('../driver/HostLifecycleTypes.js').HostAuthorityRenewalRequest): Promise<boolean> {
    if (this.cancellation || this.shutdown) return false;
    if (!this.runtime.renewAuthority) throw new Error('Native authority renewal is unavailable');
    try { await this.runtime.renewAuthority(this.authority, request); return true; }
    catch (cause) { this.finish(cause); throw cause; }
  }

  private finish(cause?: unknown): void {
    if (this.shutdown) return;
    this.shutdown = this.runtime.close(cause).then(() => {
      if (cause) this.rejectClosed(cause); else this.resolveClosed();
    }, (error) => this.rejectClosed(error));
  }
}
