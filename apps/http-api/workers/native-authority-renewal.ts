import type { HostAuthorityRenewalRequest } from '../../../packages/agent-runtime-host/src/driver/HostLifecycleTypes.js';

/** The Host and supervisor each fence at the last acknowledged lease. A live
 * ledger alone never extends a physical process, and a late ACK cannot revive it. */
export class NativeAuthorityRenewal {
  #expires: number;
  #expiryTimer?: NodeJS.Timeout;
  #pollTimer?: NodeJS.Timeout;
  #pending?: Promise<void>;
  #stopped = false;
  #renew?: (request: HostAuthorityRenewalRequest) => Promise<boolean>;

  constructor(private readonly options: {
    attemptId: string;
    initialExpiresAtUnixMs: number;
    hardDeadlineAtUnixMs: number;
    readExpiresAtUnixMs(): Promise<number>;
    lost(cause: unknown): void;
  }) {
    this.#expires = Math.min(options.initialExpiresAtUnixMs, options.hardDeadlineAtUnixMs);
    if (!Number.isSafeInteger(this.#expires)) throw new Error('Invalid native executor authority');
    this.#armExpiry();
  }

  activate(renew: (request: HostAuthorityRenewalRequest) => Promise<boolean>): void {
    if (this.#stopped) return;
    if (this.#renew) throw new Error('Native renewal owner is already active');
    this.#renew = renew;
    this.#refresh();
  }

  async close(): Promise<void> {
    this.#stop();
    await this.#pending;
  }

  #armExpiry(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = setTimeout(() => this.#fail(new Error('Native executor authority expired before renewal ACK')),
      Math.max(1, this.#expires - Date.now()));
    this.#expiryTimer.unref();
  }

  #refresh(): void {
    if (this.#stopped || this.#pending) return;
    this.#pending = this.#update().catch(cause => { if (!this.#stopped) this.#fail(cause); }).finally(() => {
      this.#pending = undefined;
      if (this.#stopped) return;
      this.#pollTimer = setTimeout(() => this.#refresh(), Math.max(25, Math.min(30_000, Math.floor((this.#expires - Date.now()) / 3))));
      this.#pollTimer.unref();
    });
  }

  async #update(): Promise<void> {
    const ledgerExpiry = await this.options.readExpiresAtUnixMs();
    if (this.#stopped) return;
    const now = Date.now();
    if (!Number.isSafeInteger(ledgerExpiry) || ledgerExpiry <= now || this.#expires <= now) {
      throw new Error('Native executor lease is no longer live');
    }
    const next = Math.min(ledgerExpiry, this.options.hardDeadlineAtUnixMs);
    if (next < this.#expires) throw new Error('Native executor lease regressed');
    if (next === this.#expires) return;
    const renewed = await this.#renew!({ leaseExpiresAtUnixMs: BigInt(next), updatedAtUnixMs: BigInt(now),
      idempotencyKey: `native-renew:${this.options.attemptId}:${next}` });
    if (this.#stopped) return;
    if (!renewed) { this.#stop(); return; }
    if (this.#expires <= Date.now()) throw new Error('Native renewal ACK arrived after expiry');
    this.#expires = next;
    this.#armExpiry();
  }

  #stop(): void {
    this.#stopped = true;
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
  }

  #fail(cause: unknown): void {
    if (this.#stopped) return;
    this.#stop();
    this.options.lost(cause);
  }
}
