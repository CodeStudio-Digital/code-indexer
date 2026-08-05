import type {
  ActiveAttemptAuthoritySnapshot,
  HostCancelAttemptRequest,
  HostFenceAttemptRequest,
} from './HostLifecycleTypes.js';
import type { ActiveAttemptAuthorityHandle } from './HostLifecycleReceipts.js';
import {
  callOwnedAttemptLifecycle,
  callOwnedAttemptLifecycleAsync,
} from './RustHostAttemptLifecycleCall.js';
import type {
  AuthenticatedAttemptLifecyclePort,
  RustHostManagementFactPort,
} from './RustHostAttemptCoordinatorTypes.js';
import { RustHostActiveFactPump } from './RustHostActiveFactPump.js';

export class RustHostActiveAttemptController {
  #facts?: RustHostActiveFactPump;

  constructor(
    private readonly lifecycle: AuthenticatedAttemptLifecyclePort,
    private readonly fail: (cause: unknown) => void,
  ) {}

  inspect(handle: ActiveAttemptAuthorityHandle): ActiveAttemptAuthoritySnapshot {
    return callOwnedAttemptLifecycle(
      this.lifecycle,
      (lifecycle) => lifecycle.inspectActive(handle),
      this.fail,
    );
  }

  startFactPump(facts: RustHostManagementFactPort): void {
    if (this.#facts) throw new Error('Active management fact pump already started');
    this.#facts = new RustHostActiveFactPump(facts, this.fail);
  }

  waitForPhysicalReap(): Promise<void> {
    if (this.#facts) return this.#facts.wait();
    return Promise.reject(new Error('Active management fact pump is unavailable'));
  }

  abortFactPump(cause?: unknown): void {
    this.#facts?.abort(cause);
  }

  async cancel(
    handle: ActiveAttemptAuthorityHandle,
    request: HostCancelAttemptRequest,
  ): Promise<void> {
    await callOwnedAttemptLifecycleAsync(
      this.lifecycle,
      (lifecycle) => lifecycle.cancel(handle, request),
      this.fail,
    );
    await this.#callManagement((facts) => facts.cancel(request));
  }

  async fence(
    handle: ActiveAttemptAuthorityHandle,
    request: HostFenceAttemptRequest,
  ): Promise<void> {
    await callOwnedAttemptLifecycleAsync(
      this.lifecycle,
      (lifecycle) => lifecycle.fence(handle, request),
      this.fail,
    );
    await this.#callManagement((facts) => facts.fence(request));
  }

  tick(): void {
    callOwnedAttemptLifecycle(
      this.lifecycle,
      (lifecycle) => lifecycle.tick(),
      this.fail,
    );
  }

  async #callManagement(
    operation: (facts: RustHostActiveFactPump) => Promise<void>,
  ): Promise<void> {
    try {
      if (!this.#facts) throw new Error('Active management fact pump is unavailable');
      await operation(this.#facts);
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
  }
}
