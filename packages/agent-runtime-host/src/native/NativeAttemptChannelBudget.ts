import type { ActiveAttemptAuthoritySnapshot } from '../driver/HostLifecycleTypes.js';

/** Soft boundary only. Authority and replay limits remain enforced separately.
 * Keep enough identities to settle admitted effects, a terminal and reaping. */
export class NativeAttemptChannelBudget {
  readonly #stop = new AbortController();
  #timer?: NodeJS.Timeout;
  get signal(): AbortSignal { return this.#stop.signal; }

  start(inspect: () => ActiveAttemptAuthoritySnapshot): void {
    if (this.#timer || this.signal.aborted) throw new Error('Attempt channel budget already started');
    const initial = inspect();
    const reserve = (value: number | undefined, maximum: number) => Math.min(maximum,
      Math.max(8, Math.floor((value ?? Infinity) / 4)));
    const controlReserve = reserve(initial.remainingControlIdentities, 8_192);
    const managementReserve = reserve(initial.remainingManagementIdentities, 1_024);
    const tick = () => {
      try {
        const state = inspect();
        if (state.signal.aborted) { this.close(); return; }
        if ((state.remainingControlIdentities ?? Infinity) <= controlReserve
          || (state.remainingManagementIdentities ?? Infinity) <= managementReserve) {
          this.#stop.abort('ipc_identity_budget');
          this.close();
        }
      } catch { this.close(); } // The lifecycle owner already fences failures.
    };
    this.#timer = setInterval(tick, 1_000);
    this.#timer.unref();
    tick();
  }

  close(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
}
