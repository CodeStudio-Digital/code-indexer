import {
  nextCommittedManagementFact,
} from './RustHostManagementFactSequence.js';
import type {
  RustHostManagementFactPort,
} from './RustHostAttemptCoordinatorTypes.js';

/** Owns the terminal management-fact receive loop for one Active attempt. */
export class RustHostActiveFactPump {
  readonly #abort = new AbortController();
  readonly #completion: Promise<void>;

  constructor(
    private readonly facts: RustHostManagementFactPort,
    fail: (cause: unknown) => void,
  ) {
    this.#completion = this.#run().catch((cause: unknown) => {
      if (!this.#abort.signal.aborted) fail(cause);
      throw cause;
    });
    void this.#completion.catch(() => undefined);
  }

  wait(): Promise<void> {
    return this.#completion;
  }

  abort(cause?: unknown): void {
    if (!this.#abort.signal.aborted) this.#abort.abort(cause);
  }

  cancel(request: Parameters<RustHostManagementFactPort['cancel']>[0]): Promise<void> {
    return this.facts.cancel(request);
  }

  fence(request: Parameters<RustHostManagementFactPort['fence']>[0]): Promise<void> {
    return this.facts.fence(request);
  }

  async #run(): Promise<void> {
    await nextCommittedManagementFact(
      this.facts,
      ['attemptProcessExited'],
      this.#abort.signal,
    );
    await nextCommittedManagementFact(
      this.facts,
      ['attemptProcessReaped'],
      this.#abort.signal,
    );
  }
}
