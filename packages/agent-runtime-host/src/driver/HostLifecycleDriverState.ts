import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';

type HostLifecycleDriverState =
  | 'awaiting_handshake'
  | 'handshaking'
  | 'established'
  | 'preparing'
  | 'prepared'
  | 'persisting'
  | 'activating'
  | 'active'
  | 'terminating'
  | 'terminated'
  | 'failed';

export class HostLifecycleDriverPhase {
  #value: HostLifecycleDriverState = 'awaiting_handshake';
  #failure?: unknown;
  readonly #failureObservers = new Set<(cause: unknown) => void>();

  transition(
    expected: HostLifecycleDriverState,
    next: HostLifecycleDriverState,
  ): void {
    this.require(expected);
    this.#value = next;
  }

  require(expected: HostLifecycleDriverState): void {
    if (this.#value === expected) return;
    throw new HostLifecycleDriverError(
      'invalid_order',
      `driver state ${this.#value} cannot perform ${expected}`,
    );
  }

  set(next: HostLifecycleDriverState): void {
    this.#value = next;
  }

  fail(cause: unknown): void {
    if (this.#value === 'failed') return;
    this.#value = 'failed';
    this.#failure = cause;
    const observers = [...this.#failureObservers];
    this.#failureObservers.clear();
    for (const observer of observers) this.#notifyFailure(observer, cause);
  }

  observeFailure(observer: (cause: unknown) => void): () => void {
    if (this.isFailed) {
      this.#notifyFailure(observer, this.#failure);
      return () => undefined;
    }
    this.#failureObservers.add(observer);
    return () => this.#failureObservers.delete(observer);
  }

  get isFailed(): boolean {
    return this.#value === 'failed';
  }

  #notifyFailure(observer: (cause: unknown) => void, cause: unknown): void {
    try {
      observer(cause);
    } catch {
      // Failure propagation cannot interrupt lifecycle teardown.
    }
  }
}
