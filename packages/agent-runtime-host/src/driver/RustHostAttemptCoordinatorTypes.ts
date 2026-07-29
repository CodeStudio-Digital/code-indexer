import type {
  agentV1Common,
  agentV1Runtime,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type { AcceptedAgentHello } from '../ipc/AgentHelloSummary.js';
import type {
  HostSupervisorLaunchOptions,
} from '../ipc/HostSupervisorBootstrapTypes.js';
import type {
  ActiveAttemptAuthoritySnapshot,
} from './HostLifecycleTypes.js';
import type {
  ActiveAttemptAuthorityHandle,
  ActiveAttemptReceipt,
  PreparedAttemptReceipt,
} from './HostLifecycleReceipts.js';
import type {
  DurableSupervisorFactPort,
  HostSupervisorFactStep,
} from './HostSupervisorFactTypes.js';

export interface RustHostManagementBootstrapPort {
  establish(): Promise<RustHostManagementLaunchPort>;
  abort(cause?: unknown): void;
}

export interface RustHostManagementLaunchPort {
  launch(
    launch: agentV1Supervisor.LaunchAttemptProcess,
    durableFacts: DurableSupervisorFactPort,
    options: HostSupervisorLaunchOptions,
  ): Promise<RustHostManagementFactPort>;
  abort(cause?: unknown): void;
}

export interface RustHostManagementFactPort {
  processNext(signal?: AbortSignal): Promise<HostSupervisorFactStep>;
  abort(cause?: unknown): void;
}

export interface AuthenticatedAttemptLifecyclePort {
  handshake(): Promise<AcceptedAgentHello>;
  prepare(
    value: agentV1Runtime.PrepareAttempt,
  ): Promise<PreparedAttemptReceipt>;
  prepareHydrated(
    value: agentV1Runtime.PrepareAttempt,
    hydrate: () => Promise<void>,
  ): Promise<PreparedAttemptReceipt>;
  activate(receipt: PreparedAttemptReceipt): Promise<ActiveAttemptReceipt>;
  consumeActive(receipt: ActiveAttemptReceipt): ActiveAttemptAuthorityHandle;
  inspectActive(
    handle: ActiveAttemptAuthorityHandle,
  ): ActiveAttemptAuthoritySnapshot;
  observeFailure(observer: (cause: unknown) => void): () => void;
  abort(): void;
  tick(): void;
  readonly isFailed: boolean;
}

export interface DurableSupervisorLaunchSnapshot {
  readonly accepted: agentV1Supervisor.LaunchAccepted;
  readonly spawned: agentV1Supervisor.AttemptProcessSpawned;
  readonly containment: agentV1Supervisor.AttemptContainmentReport;
  readonly activationAuthoritySeal: agentV1Common.ActivationAuthoritySeal;
}

export interface AuthenticatedAttemptControlContext {
  readonly integrationMode: 'test' | 'shadow';
  readonly signal: AbortSignal;
}

/**
 * Protected-handle boundary. A concrete adapter must authenticate the peer and
 * bind its control handle to every durable launch fact before resolving.
 * Tokens, endpoint addresses, and launch nonces never cross this interface.
 */
export interface AuthenticatedAttemptControlPort {
  open(
    launch: DurableSupervisorLaunchSnapshot,
    context: AuthenticatedAttemptControlContext,
  ): Promise<AuthenticatedAttemptLifecyclePort>;
  abort(cause?: unknown): void;
}

export interface AuthenticatedAttemptDataPort {
  hydrate(
    launch: DurableSupervisorLaunchSnapshot,
    context: AuthenticatedAttemptControlContext,
  ): Promise<void>;
  abort(cause?: unknown): void;
}

export interface RustHostAttemptCoordinatorOptions {
  readonly bootstrap: RustHostManagementBootstrapPort;
  readonly durableFacts: DurableSupervisorFactPort;
  readonly management: HostSupervisorLaunchOptions;
  readonly control: AuthenticatedAttemptControlPort;
  readonly data: AuthenticatedAttemptDataPort;
}

export interface RustHostAttemptRunInput {
  readonly launch: agentV1Supervisor.LaunchAttemptProcess;
  readonly prepare: agentV1Runtime.PrepareAttempt;
}

export type RustHostAttemptRunResult =
  | {
    readonly kind: 'launch_rejected';
    readonly reasonCode: string;
  }
  | {
    readonly kind: 'active';
    readonly hello: AcceptedAgentHello;
    readonly authority: ActiveAttemptAuthorityHandle;
  };
