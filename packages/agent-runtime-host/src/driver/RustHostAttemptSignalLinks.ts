import type {
  AuthenticatedAttemptLifecyclePort,
} from './RustHostAttemptCoordinatorTypes.js';

export class RustHostAttemptSignalLinks {
  #signal?: AbortSignal;
  #listener?: () => void;
  #unsubscribeFailure?: () => void;

  bindAbort(
    signal: AbortSignal | undefined,
    abort: (cause: unknown) => void,
  ): void {
    if (!signal) return;
    this.#signal = signal;
    this.#listener = () => abort(signal.reason);
    signal.addEventListener('abort', this.#listener, { once: true });
    if (signal.aborted) this.#listener();
  }

  bindLifecycle(
    lifecycle: AuthenticatedAttemptLifecyclePort,
    fail: (cause: unknown) => void,
  ): void {
    let failedSynchronously = false;
    const unsubscribe = lifecycle.observeFailure((cause) => {
      failedSynchronously = true;
      fail(cause);
    });
    if (failedSynchronously) unsubscribe();
    else this.#unsubscribeFailure = unsubscribe;
  }

  clear(): void {
    if (this.#signal && this.#listener) {
      this.#signal.removeEventListener('abort', this.#listener);
    }
    try {
      this.#unsubscribeFailure?.();
    } catch {
      // Revocation continues even if an adapter cleanup is already broken.
    }
    this.#signal = undefined;
    this.#listener = undefined;
    this.#unsubscribeFailure = undefined;
  }
}
