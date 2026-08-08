import { assertHostSupervisorFactIntegrationMode } from './HostSupervisorFactIntegrationGate.js';
import { DurableSupervisorLaunchBarrier } from './DurableSupervisorLaunchBarrier.js';
import { RustHostAttemptCoordinatorError, rustHostAttemptAborted, rustHostManagementSequenceFailure } from './RustHostAttemptCoordinatorError.js';
import { RustHostAttemptSignalLinks } from './RustHostAttemptSignalLinks.js';
import { bestEffortAttemptCleanup } from './RustHostAttemptCleanup.js';
import { openRustAttemptControl } from './RustHostAttemptControlOpen.js';
import { RustHostActiveAttemptController } from './RustHostActiveAttemptController.js';
import { scrubRustHostAttemptInput, scrubRustHostLaunchInput, scrubRustHostPrepareInput, snapshotRustHostAttemptInput } from './RustHostAttemptInputSnapshot.js';
import type { ActiveAttemptAuthoritySnapshot, HostCancelAttemptRequest, HostFenceAttemptRequest } from './HostLifecycleTypes.js';
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
  #active?: RustHostActiveAttemptController;
  #physicalReap?: Promise<void>;
  #controlOpening = false;
  #started = false;
  #closed = false;
  #failed = false;
  #abortCause?: unknown;
  readonly #signals = new RustHostAttemptSignalLinks();
  readonly #signal = new AbortController();

  constructor(options: RustHostAttemptCoordinatorOptions) {
    assertHostSupervisorFactIntegrationMode(options.management.integrationMode);
    this.#bootstrap = options.bootstrap;
    this.#durableBarrier = new DurableSupervisorLaunchBarrier(options.durableFacts);
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
    this.#signals.bindData(this.#data, (cause) => {
      if (this.#physicalReap) this.#failActive(cause);
      else this.#fail(cause);
    });
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

      const outcome = await this.#nextCommitted(['launchAccepted', 'launchRejected']);
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
      this.#active!.startFactPump(this.#facts!);
      this.#physicalReap = this.#active!.waitForPhysicalReap();
      return { kind: 'active', hello, authority };
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    } finally {
      scrubRustHostAttemptInput(request);
    }
  }
  inspectActive(handle: ActiveAttemptAuthorityHandle): ActiveAttemptAuthoritySnapshot {
    this.#assertOpen();
    return this.#requireActive().inspect(handle);
  }
  cancelActive(handle: ActiveAttemptAuthorityHandle, request: HostCancelAttemptRequest): Promise<void> {
    this.#assertOpen();
    this.#data.beginTermination?.();
    return this.#requireActive().cancel(handle, request);
  }
  fenceActive(handle: ActiveAttemptAuthorityHandle, request: HostFenceAttemptRequest): Promise<void> {
    this.#assertOpen();
    this.#data.beginTermination?.();
    return this.#requireActive().fence(handle, request);
  }
  waitForPhysicalReap(): Promise<void> {
    if (this.#physicalReap) return this.#physicalReap;
    this.#assertOpen();
    return this.#requireActive().waitForPhysicalReap();
  }
  tick(): void {
    this.#assertOpen();
    this.#active?.tick();
  }
  abort(cause?: unknown): void {
    this.#fail(cause ?? rustHostAttemptAborted());
  }

  get isFailed(): boolean {
    return this.#failed || this.#lifecycle?.isFailed === true;
  }
  get failureCause(): unknown {
    return this.#abortCause;
  }
  async #nextCommitted(
    expected: Parameters<typeof nextCommittedManagementFact>[1],
  ): ReturnType<typeof nextCommittedManagementFact> {
    return nextCommittedManagementFact(this.#facts, expected, this.#signal.signal);
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
    this.#active = new RustHostActiveAttemptController(
      lifecycle,
      (cause) => this.#failActive(cause),
    );
    this.#signals.bindLifecycle(lifecycle, (cause) => this.#failActive(cause));
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
  #fail(cause: unknown, preservePhysicalReap = false): void {
    if (this.#closed) return;
    const preserveFacts = preservePhysicalReap && this.#physicalReap !== undefined;
    this.#closed = true;
    this.#failed = true;
    this.#abortCause = cause;
    const bootstrap = this.#bootstrap;
    const launch = this.#launch;
    const facts = this.#facts;
    const lifecycle = this.#lifecycle;
    const active = this.#active;
    const controlOpening = this.#controlOpening;
    this.#bootstrap = undefined;
    this.#launch = undefined;
    this.#facts = undefined;
    this.#lifecycle = undefined;
    this.#active = undefined;
    this.#controlOpening = false;
    if (!preserveFacts) this.#durableBarrier.discard();
    this.#signals.clear();
    bestEffortAttemptCleanup([
      () => this.#signal.abort(cause),
      () => bootstrap?.abort(cause),
      () => launch?.abort(cause),
      () => { if (!preserveFacts) active?.abortFactPump(cause); },
      () => { if (!preserveFacts) facts?.abort(cause); },
      () => { if (controlOpening) this.#control.abort(cause); },
      () => this.#data.abort(cause),
      () => lifecycle?.abort(),
    ]);
  }
  // Active failure revokes Control/Data but preserves facts through reap.
  #failActive(cause: unknown): void {
    this.#fail(cause, true);
  }
  #assertOpen(): void {
    if (this.#closed) throw rustHostAttemptAborted(this.#abortCause);
  }

  #requireActive(): RustHostActiveAttemptController {
    if (this.#active) return this.#active;
    throw new RustHostAttemptCoordinatorError(
      'management_sequence',
      'active lifecycle authority is unavailable',
    );
  }
}
