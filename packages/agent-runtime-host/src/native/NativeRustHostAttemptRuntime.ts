import { detachedMessage } from '../ipc/DetachedMessage.js';
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
  RustHostAttemptRunResult,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import { scrubLaunch } from '../ipc/HostSupervisorLaunchValidation.js';
import type {
  NativeHostSupervisorCloseReceipt,
} from './NativeHostBridgeBinding.js';
import {
  createNativeHostSupervisorManagementBootstrap,
  type NativeHostSupervisorManagementOwner,
} from './NativeHostSupervisorManagement.js';
import {
  createNativeShadowAttemptAdapters,
} from './NativeShadowAttemptAdapters.js';
import {
  NativeDurableEngineEventCommitter,
} from './NativeDurableEngineEventCommitter.js';
import type {
  UnresolvedCapabilityDispatch,
} from './NativeEngineEventRecoveryTypes.js';
import type { EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';
import { NativeAttemptChannelBudget } from './NativeAttemptChannelBudget.js';
import { withChannelBudget } from './NativeChannelBudgetData.js';
import { withNativeTerminalCommitBarrier } from './NativeTerminalCommitBarrier.js';
import { prepareNativeRuntimeSession } from './NativeRuntimeSessionPreparation.js';

import type { NativeRustHostAttemptRuntimeOptions } from './NativeRustHostAttemptRuntimeTypes.js';
export type { NativeRustHostAttemptRuntimeOptions } from './NativeRustHostAttemptRuntimeTypes.js';

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
    private readonly channelBudget: NativeAttemptChannelBudget,
    sessionStore?: NativeDurableEngineEventCommitter,
  ) {
    this.#owner = owner;
    this.#coordinator = coordinator;
    this.#launch = launch;
    this.#sessionStore = sessionStore;
  }

  static async create(
    options: NativeRustHostAttemptRuntimeOptions,
    signal?: AbortSignal,
  ): Promise<NativeRustHostAttemptRuntime> {
    const launch = detachedMessage(
      agentV1Supervisor.LaunchAttemptProcessSchema,
      options.launch,
    );
    let owner: NativeHostSupervisorManagementOwner | undefined;
    let sessionStore: NativeDurableEngineEventCommitter | undefined;
    const channelBudget = new NativeAttemptChannelBudget();
    try {
      const prepared = await prepareNativeRuntimeSession(options, signal);
      sessionStore = prepared.sessionStore;
      options.beforeSupervisorSpawn?.();
      owner = await createNativeHostSupervisorManagementBootstrap({
        binding: options.binding,
        runtimePackage: options.runtimePackage,
        provision: options.supervisor,
        lifecycleOutboxDirectory: prepared.lifecycleOutboxDirectory,
      });
      signal?.throwIfAborted();
      const adapters = createNativeShadowAttemptAdapters({
        binding: options.binding,
        launch,
        openDeadlineAtUnixMs: options.openDeadlineAtUnixMs,
        control: options.control,
        data: withChannelBudget(sessionStore
          ? { ...options.data, engineEventCommitter: withNativeTerminalCommitBarrier(sessionStore, options.beforeTerminalCommit) }
          : options.data, channelBudget.signal),
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
        channelBudget,
        sessionStore,
      );
    } catch (cause) {
      channelBudget.close();
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
      .then(result => {
        if (result.kind === 'active') this.channelBudget.start(() => this.inspectActive(result.authority));
        return result;
      })
      .finally(() => scrubLaunch(launch));
  }

  inspectActive(
    handle: ActiveAttemptAuthorityHandle,
  ): ActiveAttemptAuthoritySnapshot {
    return this.#coordinator.inspectActive(handle);
  }

  renewAuthority(handle: ActiveAttemptAuthorityHandle, request: import('../driver/HostLifecycleTypes.js').HostAuthorityRenewalRequest): Promise<void> {
    return this.#coordinator.renewAuthority(handle, request);
  }

  cancelActive(
    handle: ActiveAttemptAuthorityHandle,
    request: HostCancelAttemptRequest,
  ): Promise<void> {
    this.channelBudget.close();
    return this.#coordinator.cancelActive(handle, request);
  }

  fenceActive(
    handle: ActiveAttemptAuthorityHandle,
    request: HostFenceAttemptRequest,
  ): Promise<void> {
    this.channelBudget.close();
    return this.#coordinator.fenceActive(handle, request);
  }

  waitForPhysicalReap(): Promise<void> {
    return this.#coordinator.waitForPhysicalReap();
  }

  waitForTerminal() {
    if (!this.#sessionStore) return Promise.reject(new Error('native session store is not configured'));
    return this.#sessionStore.waitForTerminal().finally(() => this.channelBudget.close());
  }

  get latestEventSequence(): bigint { return this.#sessionStore?.latestSequence ?? 0n; }
  get identityBudgetSignal(): AbortSignal { return this.channelBudget.signal; }
  readCommittedHistory<T>(project: (store: EngineEventRecoveryStorePort) => Promise<T>): Promise<T | undefined> {
    if (this.#closed || !this.#sessionStore) return Promise.resolve(undefined);
    return this.#sessionStore.readCommittedHistory(project);
  }
  commitAttachment(...args: Parameters<NativeDurableEngineEventCommitter['commitAttachment']>): Promise<void> {
    if (!this.#sessionStore) return Promise.reject(new Error('native session store is not configured'));
    return this.#sessionStore.commitAttachment(...args);
  }
  subscribeCommittedEvents(afterSequence = 0n, signal?: AbortSignal) {
    if (!this.#sessionStore) throw new Error('native session store is not configured');
    return this.#sessionStore.subscribeCommittedEvents(afterSequence, signal);
  }
  replayCommittedEvents(afterSequence = 0n, maximumRecords = 100_000, signal?: AbortSignal) {
    if (!this.#sessionStore) throw new Error('native session store is not configured');
    return this.#sessionStore.replayCommittedEvents(afterSequence, maximumRecords, signal);
  }

  inspectUnresolvedCapabilityDispatches(
    maximumRecords: number,
  ): Promise<readonly UnresolvedCapabilityDispatch[]> {
    if (!this.#sessionStore) {
      return Promise.reject(new Error('native session store is not configured'));
    }
    return this.#sessionStore.inspectUnresolvedCapabilityDispatches(maximumRecords);
  }

  inspectProviderFrontier(agentRunId: string, maximumRecords: number) {
    if (!this.#sessionStore) return Promise.reject(new Error('native session store is not configured'));
    return this.#sessionStore.inspectProviderFrontier(agentRunId, maximumRecords);
  }


  tick(): void {
    this.#coordinator.tick();
  }

  async close(cause?: unknown): Promise<NativeHostSupervisorCloseReceipt> {
    this.channelBudget.close();
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
