import { clone } from '@bufbuild/protobuf';
import {
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import {
  RustHostAttemptCoordinator,
} from '../driver/RustHostAttemptCoordinator.js';
import type {
  ActiveAttemptAuthoritySnapshot,
  HostCancelAttemptRequest,
  HostFenceAttemptRequest,
} from '../driver/HostLifecycleTypes.js';
import type {
  ActiveAttemptAuthorityHandle,
} from '../driver/HostLifecycleReceipts.js';
import type {
  RustHostAttemptCoordinatorOptions,
  RustHostAttemptRunResult,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import type {
  HostSupervisorBootstrapProvision,
} from '../ipc/HostSupervisorBootstrapTypes.js';
import { scrubLaunch } from '../ipc/HostSupervisorLaunchValidation.js';
import type {
  VerifiedRuntimePackage,
} from '../packaging/RuntimePackageTypes.js';
import type {
  NativeHostBridgeBinding,
  NativeHostSupervisorCloseReceipt,
} from './NativeHostBridgeBinding.js';
import {
  createNativeHostSupervisorManagementBootstrap,
  type NativeHostSupervisorManagementOwner,
} from './NativeHostSupervisorManagement.js';
import {
  createNativeShadowAttemptAdapters,
  type NativeShadowAttemptAdaptersOptions,
} from './NativeShadowAttemptAdapters.js';
import {
  NativeDurableEngineEventCommitter,
  type NativeDurableEngineEventCommitterOptions,
} from './NativeDurableEngineEventCommitter.js';
import type {
  UnresolvedCapabilityDispatch,
} from './NativeEngineEventRecoveryTypes.js';

export interface NativeRustHostAttemptRuntimeOptions {
  readonly binding: NativeHostBridgeBinding;
  readonly runtimePackage: VerifiedRuntimePackage;
  readonly supervisor: HostSupervisorBootstrapProvision;
  readonly launch: agentV1Supervisor.LaunchAttemptProcess;
  readonly openDeadlineAtUnixMs: bigint;
  readonly durableFacts: RustHostAttemptCoordinatorOptions['durableFacts'];
  readonly management: RustHostAttemptCoordinatorOptions['management'];
  readonly control: NativeShadowAttemptAdaptersOptions['control'];
  readonly data: NativeShadowAttemptAdaptersOptions['data'];
  readonly sessionStore?: NativeDurableEngineEventCommitterOptions;
}

/**
 * Single process-real composition root for one Rust attempt.
 *
 * It owns the launch secrets, semantic coordinator, native attempt channels,
 * supervisor process, and the runner process contained by that supervisor.
 */
export class NativeRustHostAttemptRuntime {
  readonly #owner: NativeHostSupervisorManagementOwner;
  readonly #coordinator: RustHostAttemptCoordinator;
  #launch?: agentV1Supervisor.LaunchAttemptProcess;
  readonly #sessionStore?: NativeDurableEngineEventCommitter;
  #closed = false;

  private constructor(
    owner: NativeHostSupervisorManagementOwner,
    coordinator: RustHostAttemptCoordinator,
    launch: agentV1Supervisor.LaunchAttemptProcess,
    sessionStore?: NativeDurableEngineEventCommitter,
  ) {
    this.#owner = owner;
    this.#coordinator = coordinator;
    this.#launch = launch;
    this.#sessionStore = sessionStore;
  }

  static async create(
    options: NativeRustHostAttemptRuntimeOptions,
  ): Promise<NativeRustHostAttemptRuntime> {
    const launch = clone(
      agentV1Supervisor.LaunchAttemptProcessSchema,
      options.launch,
    );
    let owner: NativeHostSupervisorManagementOwner | undefined;
    let sessionStore: NativeDurableEngineEventCommitter | undefined;
    try {
      owner = await createNativeHostSupervisorManagementBootstrap({
        binding: options.binding,
        runtimePackage: options.runtimePackage,
        provision: options.supervisor,
      });
      if (options.sessionStore && options.data.engineEventCommitter) {
        throw new Error('native session store authority is ambiguous');
      }
      sessionStore = options.sessionStore
        ? await NativeDurableEngineEventCommitter.open(
          options.binding,
          options.sessionStore,
        )
        : undefined;
      const adapters = createNativeShadowAttemptAdapters({
        binding: options.binding,
        launch,
        openDeadlineAtUnixMs: options.openDeadlineAtUnixMs,
        control: options.control,
        data: sessionStore
          ? { ...options.data, engineEventCommitter: sessionStore }
          : options.data,
      });
      const coordinator = new RustHostAttemptCoordinator({
        bootstrap: owner,
        durableFacts: options.durableFacts,
        management: options.management,
        control: adapters.control,
        data: adapters.data,
      });
      return new NativeRustHostAttemptRuntime(
        owner,
        coordinator,
        launch,
        sessionStore,
      );
    } catch (cause) {
      scrubLaunch(launch);
      await sessionStore?.close().catch(() => undefined);
      await owner?.close().catch(() => undefined);
      throw cause;
    }
  }

  run(
    prepare: agentV1Runtime.PrepareAttempt,
    signal?: AbortSignal,
  ): Promise<RustHostAttemptRunResult> {
    if (this.#closed || !this.#launch) {
      return Promise.reject(new Error(
        'native Rust Host attempt runtime is closed or already started',
      ));
    }
    const launch = this.#launch;
    this.#launch = undefined;
    return this.#coordinator.run({ launch, prepare }, signal)
      .finally(() => scrubLaunch(launch));
  }

  inspectActive(
    handle: ActiveAttemptAuthorityHandle,
  ): ActiveAttemptAuthoritySnapshot {
    return this.#coordinator.inspectActive(handle);
  }

  cancelActive(
    handle: ActiveAttemptAuthorityHandle,
    request: HostCancelAttemptRequest,
  ): Promise<void> {
    return this.#coordinator.cancelActive(handle, request);
  }

  fenceActive(
    handle: ActiveAttemptAuthorityHandle,
    request: HostFenceAttemptRequest,
  ): Promise<void> {
    return this.#coordinator.fenceActive(handle, request);
  }

  waitForPhysicalReap(): Promise<void> {
    return this.#coordinator.waitForPhysicalReap();
  }

  inspectUnresolvedCapabilityDispatches(
    maximumRecords: number,
  ): Promise<readonly UnresolvedCapabilityDispatch[]> {
    if (!this.#sessionStore) {
      return Promise.reject(new Error('native session store is not configured'));
    }
    return this.#sessionStore.inspectUnresolvedCapabilityDispatches(maximumRecords);
  }


  tick(): void {
    this.#coordinator.tick();
  }

  async close(cause?: unknown): Promise<NativeHostSupervisorCloseReceipt> {
    if (!this.#closed) {
      this.#closed = true;
      scrubLaunch(this.#launch);
      this.#launch = undefined;
      this.#coordinator.abort(cause);
    }
    await this.#sessionStore?.close().catch(() => undefined);
    return this.#owner.close();
  }

  get supervisorProcessId(): number {
    return this.#owner.supervisorProcessId;
  }

  get isFailed(): boolean {
    return this.#coordinator.isFailed;
  }

  get failureCause(): unknown {
    return this.#coordinator.failureCause;
  }
}
