import { assertHostSupervisorFactIntegrationMode } from './HostSupervisorFactIntegrationGate.js';
import { DurableSupervisorLaunchBarrier } from './DurableSupervisorLaunchBarrier.js';
import {
  RustHostAttemptCoordinatorError,
  rustHostAttemptAborted,
  rustHostManagementSequenceFailure,
} from './RustHostAttemptCoordinatorError.js';
import { RustHostAttemptSignalLinks } from './RustHostAttemptSignalLinks.js';
import { bestEffortAttemptCleanup } from './RustHostAttemptCleanup.js';
import { openRustAttemptControl } from './RustHostAttemptControlOpen.js';
import { callOwnedAttemptLifecycle } from './RustHostAttemptLifecycleCall.js';
import {
  scrubRustHostAttemptInput,
  scrubRustHostLaunchInput,
  scrubRustHostPrepareInput,
  snapshotRustHostAttemptInput,
} from './RustHostAttemptInputSnapshot.js';
import type { ActiveAttemptAuthoritySnapshot } from './HostLifecycleTypes.js';
import type { ActiveAttemptAuthorityHandle } from './HostLifecycleReceipts.js';
import { nextCommittedManagementFact } from './RustHostManagementFactSequence.js';
import type {
  AuthenticatedAttemptLifecyclePort, RustHostAttemptCoordinatorOptions,
  RustHostAttemptRunInput, RustHostAttemptRunResult,
  RustHostManagementBootstrapPort, RustHostManagementFactPort,
  RustHostManagementLaunchPort,
} from './RustHostAttemptCoordinatorTypes.js';

/** Internal first-launch composition for Rust Host shadow/test execution. */
export class RustHostAttemptCoordinator {
  readonly #durableBarrier: DurableSupervisorLaunchBarrier;
  readonly #managementOptions;
  readonly #control;
  readonly #data;
  #bootstrap?: RustHostManagementBootstrapPort;
  #launch?: RustHostManagementLaunchPort;
  #facts?: RustHostManagementFactPort;
  #lifecycle?: AuthenticatedAttemptLifecyclePort;
  #controlOpening = false;
  #started = false;
  #closed = false;
  #failed = false;
  #abortCause?: unknown;
  readonly #signals = new RustHostAttemptSignalLinks();
  readonly #signal = new AbortController();

  constructor(options: RustHostAttemptCoordinatorOptions) {
    assertHostSupervisorFactIntegrationMode(
      options.management.integrationMode,
    );
    this.#bootstrap = options.bootstrap;
    this.#durableBarrier = new DurableSupervisorLaunchBarrier(
      options.durableFacts,
    );
    this.#managementOptions = Object.freeze({ ...options.management });
    this.#control = options.control;
    this.#data = options.data;
  }

  async run(
    input: RustHostAttemptRunInput,
    signal?: AbortSignal,
  ): Promise<RustHostAttemptRunResult> {
    if (this.#started) {
      throw new RustHostAttemptCoordinatorError(
        'already_started',
        'Rust Host attempt coordinator is single-use',
      );
    }
    const request = snapshotRustHostAttemptInput(input);
    this.#started = true;
    this.#signals.bindAbort(signal, (cause) => this.abort(cause));
    try {
      this.#assertOpen();
      this.#durableBarrier.bindActivationAuthoritySeal(
        request.launch.activationAuthoritySeal,
      );
      const capability = await this.#bootstrap!.establish();
      this.#adoptLaunch(capability);
      const facts = await capability.launch(
        request.launch,
        this.#durableBarrier,
        this.#managementOptions,
      ).finally(() => scrubRustHostLaunchInput(request));
      this.#adoptFacts(facts);

      const outcome = await this.#nextCommitted([
        'launchAccepted',
        'launchRejected',
      ]);
      if (outcome.factCase === 'launchRejected') {
        const reasonCode = this.#durableBarrier.releaseRejectedReasonCode();
        this.#closeRejected();
        return { kind: 'launch_rejected', reasonCode };
      }
      await this.#nextCommitted(['attemptProcessSpawned']);
      await this.#nextCommitted(['attemptContainmentReport']);
      const durableLaunch = this.#durableBarrier.releaseAccepted();

      this.#controlOpening = true;
      const lifecycle = await openRustAttemptControl(
        this.#control.open(durableLaunch, {
          integrationMode: this.#managementOptions.integrationMode,
          signal: this.#signal.signal,
        }),
        this.#signal.signal,
      );
      this.#adoptLifecycle(lifecycle);
      const hello = await lifecycle.handshake();
      this.#assertOpen();
      const prepared = await lifecycle.prepareHydrated(
        request.prepare,
        () => this.#data.hydrate(durableLaunch, {
          integrationMode: this.#managementOptions.integrationMode,
          signal: this.#signal.signal,
        }),
      )
        .finally(() => scrubRustHostPrepareInput(request));
      this.#assertOpen();
      const active = await lifecycle.activate(prepared);
      this.#assertOpen();
      const authority = lifecycle.consumeActive(active);
      return { kind: 'active', hello, authority };
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    } finally {
      scrubRustHostAttemptInput(request);
    }
  }

  inspectActive(
    handle: ActiveAttemptAuthorityHandle,
  ): ActiveAttemptAuthoritySnapshot {
    this.#assertOpen();
    if (!this.#lifecycle) {
      throw new RustHostAttemptCoordinatorError(
        'management_sequence',
        'active lifecycle authority is unavailable',
      );
    }
    return callOwnedAttemptLifecycle(
      this.#lifecycle,
      (lifecycle) => lifecycle.inspectActive(handle),
      (cause) => this.#fail(cause),
    );
  }

  tick(): void {
    this.#assertOpen();
    if (!this.#lifecycle) return;
    callOwnedAttemptLifecycle(
      this.#lifecycle,
      (lifecycle) => lifecycle.tick(),
      (cause) => this.#fail(cause),
    );
  }

  abort(cause?: unknown): void {
    this.#fail(cause ?? rustHostAttemptAborted());
  }

  get isFailed(): boolean {
    return this.#failed || this.#lifecycle?.isFailed === true;
  }

  async #nextCommitted(
    expected: Parameters<typeof nextCommittedManagementFact>[1],
  ): ReturnType<typeof nextCommittedManagementFact> {
    const facts = this.#facts;
    if (!facts) {
      throw rustHostManagementSequenceFailure(
        'management fact stream is unavailable',
      );
    }
    return nextCommittedManagementFact(facts, expected, this.#signal.signal);
  }

  #adoptLaunch(capability: RustHostManagementLaunchPort): void {
    this.#bootstrap = undefined;
    if (this.#closed) {
      capability.abort(this.#abortCause);
      throw rustHostAttemptAborted(this.#abortCause);
    }
    this.#launch = capability;
  }

  #adoptFacts(facts: RustHostManagementFactPort): void {
    this.#launch = undefined;
    if (this.#closed) {
      facts.abort(this.#abortCause);
      throw rustHostAttemptAborted(this.#abortCause);
    }
    this.#facts = facts;
  }

  #adoptLifecycle(lifecycle: AuthenticatedAttemptLifecyclePort): void {
    this.#controlOpening = false;
    if (this.#closed) {
      lifecycle.abort();
      throw rustHostAttemptAborted(this.#abortCause);
    }
    this.#lifecycle = lifecycle;
    this.#signals.bindLifecycle(lifecycle, (cause) => this.#fail(cause));
  }

  #closeRejected(): void {
    if (this.#closed) return;
    this.#closed = true;
    const facts = this.#facts;
    this.#facts = undefined;
    this.#signals.clear();
    bestEffortAttemptCleanup([() => facts?.abort(
      rustHostManagementSequenceFailure('launch was durably rejected'),
    ), () => this.#control.abort(), () => this.#data.abort()]);
  }

  #fail(cause: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failed = true;
    this.#abortCause = cause;
    const bootstrap = this.#bootstrap;
    const launch = this.#launch;
    const facts = this.#facts;
    const lifecycle = this.#lifecycle;
    const controlOpening = this.#controlOpening;
    this.#bootstrap = undefined;
    this.#launch = undefined;
    this.#facts = undefined;
    this.#lifecycle = undefined;
    this.#controlOpening = false;
    this.#durableBarrier.discard();
    this.#signals.clear();
    bestEffortAttemptCleanup([
      () => this.#signal.abort(cause),
      () => bootstrap?.abort(cause),
      () => launch?.abort(cause),
      () => facts?.abort(cause),
      () => { if (controlOpening) this.#control.abort(cause); },
      () => this.#data.abort(cause),
      () => lifecycle?.abort(),
    ]);
  }

  #assertOpen(): void {
    if (this.#closed) throw rustHostAttemptAborted(this.#abortCause);
  }

}
