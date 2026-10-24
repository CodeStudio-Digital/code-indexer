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
  #renewal?: Promise<void>;
  #terminating = false;

  constructor(
    private readonly lifecycle: AuthenticatedAttemptLifecyclePort,
    private readonly fail: (cause: unknown) => void,
  ) {}

  inspect(handle: ActiveAttemptAuthorityHandle): ActiveAttemptAuthoritySnapshot {
    const snapshot = callOwnedAttemptLifecycle(
      this.lifecycle,
      (lifecycle) => lifecycle.inspectActive(handle),
      this.fail,
    );
    return Object.freeze({ ...snapshot, remainingManagementIdentities: this.#facts?.remainingIdentityCapacity });
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

  async renewAuthority(handle: ActiveAttemptAuthorityHandle, request: import('./HostLifecycleTypes.js').HostAuthorityRenewalRequest): Promise<void> {
    if (this.#terminating || this.#renewal) throw new Error('Authority renewal is already pending or the attempt is closing');
    this.inspect(handle).signal.throwIfAborted();
    this.#renewal = this.#callManagement((facts) => facts.renewAuthority(request));
    try {
      await this.#renewal;
      if (!this.#terminating) this.inspect(handle).signal.throwIfAborted();
    } finally { this.#renewal = undefined; }
  }

  async cancel(
    handle: ActiveAttemptAuthorityHandle,
    request: HostCancelAttemptRequest,
  ): Promise<void> {
    this.#terminating = true;
    await callOwnedAttemptLifecycleAsync(
      this.lifecycle,
      (lifecycle) => lifecycle.cancel(handle, request),
      this.fail,
    );
    await this.#renewal;
    await this.#callManagement((facts) => facts.cancel(request));
  }

  async fence(
    handle: ActiveAttemptAuthorityHandle,
    request: HostFenceAttemptRequest,
  ): Promise<void> {
    this.#terminating = true;
    await callOwnedAttemptLifecycleAsync(
      this.lifecycle,
      (lifecycle) => lifecycle.fence(handle, request),
      this.fail,
    );
    await this.#renewal;
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
