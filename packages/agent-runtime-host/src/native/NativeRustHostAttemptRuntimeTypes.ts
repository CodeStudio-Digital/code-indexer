import type { agentV1Runtime, agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import type { RustHostAttemptCoordinatorOptions } from '../driver/RustHostAttemptCoordinatorTypes.js';
import type { HostSupervisorBootstrapProvision } from '../ipc/HostSupervisorBootstrapTypes.js';
import type { VerifiedRuntimePackage } from '../packaging/RuntimePackageTypes.js';
import type { NativeHostBridgeBinding } from './NativeHostBridgeBinding.js';
import type { NativeShadowAttemptAdaptersOptions } from './NativeShadowAttemptAdapters.js';
import type { NativeDurableEngineEventCommitter, NativeDurableEngineEventCommitterOptions } from './NativeDurableEngineEventCommitter.js';

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
  /** Prepare durable attachments before opening any process or handshake window. */
  readonly sessionStoreReady?: (store: NativeDurableEngineEventCommitter) => void | Promise<void>;
  /** Synchronous resource reservation immediately before a supervisor may spawn. */
  readonly beforeSupervisorSpawn?: () => void;
  readonly beforeTerminalCommit?: import('./NativeTerminalCommitBarrier.js').NativeTerminalCommitBarrier;
}
