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
  #closed = false;

  private constructor(
    owner: NativeHostSupervisorManagementOwner,
    coordinator: RustHostAttemptCoordinator,
    launch: agentV1Supervisor.LaunchAttemptProcess,
  ) {
    this.#owner = owner;
    this.#coordinator = coordinator;
    this.#launch = launch;
  }

  static async create(
    options: NativeRustHostAttemptRuntimeOptions,
  ): Promise<NativeRustHostAttemptRuntime> {
    const launch = clone(
      agentV1Supervisor.LaunchAttemptProcessSchema,
      options.launch,
    );
    let owner: NativeHostSupervisorManagementOwner | undefined;
    try {
      owner = await createNativeHostSupervisorManagementBootstrap({
        binding: options.binding,
        runtimePackage: options.runtimePackage,
        provision: options.supervisor,
      });
      const adapters = createNativeShadowAttemptAdapters({
        binding: options.binding,
        launch,
        openDeadlineAtUnixMs: options.openDeadlineAtUnixMs,
        control: options.control,
        data: options.data,
      });
      const coordinator = new RustHostAttemptCoordinator({
        bootstrap: owner,
        durableFacts: options.durableFacts,
        management: options.management,
        control: adapters.control,
        data: adapters.data,
      });
      return new NativeRustHostAttemptRuntime(owner, coordinator, launch);
    } catch (cause) {
      scrubLaunch(launch);
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
    return this.#owner.close();
  }

  get supervisorProcessId(): number {
    return this.#owner.supervisorProcessId;
  }

  get isFailed(): boolean {
    return this.#coordinator.isFailed;
  }
}
