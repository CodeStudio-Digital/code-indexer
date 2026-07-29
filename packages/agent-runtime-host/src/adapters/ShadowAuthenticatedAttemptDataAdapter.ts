import type {
  AuthenticatedAttemptControlContext,
  AuthenticatedAttemptDataPort,
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import type {
  HostBoundDataAttemptChannel,
  HostPendingDataAttemptChannel,
} from '../ipc/HostDataAttemptChannel.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';
import {
  awaitAuthenticatedAttemptConnection,
} from './AttemptEndpointOpenSettlement.js';
import {
  bindDurableAttemptDataLaunch,
} from './DurableAttemptControlBinding.js';
import {
  type AuthenticatedAttemptDataConnection,
  type AuthenticatedAttemptDataConnectionOwner,
  type ProtectedAttemptDataEndpoint,
  type ProtectedAttemptDataEndpointOwner,
  assertDataCleanupDisposition,
  consumeAuthenticatedAttemptDataConnection,
  consumeProtectedAttemptDataEndpoint,
  revokeAuthenticatedAttemptDataConnection,
} from './ProtectedAttemptDataEndpoint.js';
import {
  assertPhysicalAttemptDataConnection,
  createPendingHostDataChannel,
  handoffPhysicalAttemptDataTransport,
  revokePhysicalAttemptDataConnection,
} from './ShadowAttemptDataLifecycle.js';
import {
  normalizeShadowAttemptDataFailure,
} from './ShadowAttemptDataFailure.js';
import {
  type ShadowAttemptDataPlan,
  type ShadowAttemptDataPlanInput,
  scrubShadowAttemptDataPlan,
  snapshotShadowAttemptDataPlan,
} from './ShadowAttemptDataPlan.js';
import {
  assertShadowAttemptIntegrationMode,
} from './ShadowAttemptIntegrationGate.js';

type AdapterPhase =
  'ready' | 'opening' | 'binding' | 'hydrating' | 'hydrated' | 'failed';

export interface ShadowAuthenticatedAttemptDataAdapterOptions
extends ShadowAttemptDataPlanInput {
  readonly endpoint: ProtectedAttemptDataEndpointOwner;
  readonly clock: AuthorityClock;
}

/**
 * Test/shadow Data composition. It binds the physical peer to durable launch
 * facts, transfers the authenticated transport once, and streams the
 * filesystem hydration source before allowing Control Prepared to commit.
 */
export class ShadowAuthenticatedAttemptDataAdapter
implements AuthenticatedAttemptDataPort {
  #endpoint?: ProtectedAttemptDataEndpoint;
  #plan?: ShadowAttemptDataPlan;
  #clock?: AuthorityClock;
  #phase: AdapterPhase = 'ready';
  #operationAbort?: AbortController;
  #unlinkExternalAbort?: () => void;
  #channelAbort?: (cause?: unknown) => void;
  #sourceTransferred = false;
  #failureCause?: unknown;

  constructor(options: ShadowAuthenticatedAttemptDataAdapterOptions) {
    const endpoint = consumeProtectedAttemptDataEndpoint(options.endpoint);
    let plan: ShadowAttemptDataPlan | undefined;
    try {
      plan = snapshotShadowAttemptDataPlan(options);
      if (typeof options.clock?.now !== 'function') {
        throw new RangeError('authority clock');
      }
      this.#plan = plan;
      this.#clock = options.clock;
      this.#endpoint = endpoint;
    } catch (cause) {
      scrubShadowAttemptDataPlan(plan, cause);
      bestEffort(() => assertDataCleanupDisposition(endpoint.abort(cause)));
      throw cause;
    }
  }

  async hydrate(
    launch: DurableSupervisorLaunchSnapshot,
    context: AuthenticatedAttemptControlContext,
  ): Promise<void> {
    this.#assertReady();
    this.#phase = 'opening';
    const plan = this.#plan!;
    let owner: AuthenticatedAttemptDataConnectionOwner | undefined;
    let connection: AuthenticatedAttemptDataConnection | undefined;
    let transport: DelimitedByteChannel | undefined;
    try {
      assertShadowAttemptIntegrationMode(context.integrationMode);
      const bound = bindDurableAttemptDataLaunch(launch, plan);
      const signal = this.#startCancellation(context.signal);
      this.#assertPhase('opening');
      const operation = this.#endpoint!.open({
        endpointId: plan.endpointId,
        connectionId: plan.connectionId,
        reservationId: bound.reservationId,
        resourceGroupId: bound.resourceGroupId,
        expectedPeerPid: bound.runnerProvenance.pid,
        maximumFrameBytes: Number(plan.effectiveLimits.maxFrameBytes),
        deadlineAtUnixMs: plan.specDeadlineAtUnixMs,
        signal,
      });
      owner = await awaitAuthenticatedAttemptConnection(
        operation,
        signal,
        revokeAuthenticatedAttemptDataConnection,
      );
      this.#assertPhase('opening');
      connection = consumeAuthenticatedAttemptDataConnection(owner);
      owner = undefined;
      assertPhysicalAttemptDataConnection(connection, plan, bound);
      transport = handoffPhysicalAttemptDataTransport(connection);
      connection = undefined;
      this.#phase = 'binding';
      const pending = createPendingHostDataChannel(
        transport,
        plan,
        bound,
        this.#clock!,
      );
      transport = undefined;
      plan.connectionToken.fill(0);
      this.#endpoint = undefined;
      this.#ownPending(pending);
      const channel = await pending.bind();
      this.#assertPhase('binding');
      this.#phase = 'hydrating';
      this.#ownBound(channel);
      this.#sourceTransferred = true;
      await channel.hydrate({ ...plan.hydration, signal });
      this.#assertPhase('hydrating');
      this.#completeHydration();
    } catch (cause) {
      if (owner) {
        revokeAuthenticatedAttemptDataConnection(owner, cause);
      }
      if (connection) revokePhysicalAttemptDataConnection(connection, cause);
      if (transport) bestEffort(() => transport?.fail(cause));
      this.#fail(cause);
      throw normalizeShadowAttemptDataFailure(this.#failureCause ?? cause);
    }
  }

  abort(cause?: unknown): void {
    this.#fail(new AttemptControlAdapterError(
      'aborted',
      'shadow attempt data adapter was aborted',
      cause === undefined ? undefined : { cause },
    ));
  }

  #startCancellation(external: AbortSignal): AbortSignal {
    const controller = new AbortController();
    this.#operationAbort = controller;
    const abort = () => this.abort(external.reason);
    if (external.aborted) {
      abort();
      return controller.signal;
    }
    external.addEventListener('abort', abort, { once: true });
    this.#unlinkExternalAbort = () => {
      external.removeEventListener('abort', abort);
    };
    return controller.signal;
  }

  #ownPending(channel: HostPendingDataAttemptChannel): void {
    this.#channelAbort = (cause) => channel.abort(cause);
  }

  #ownBound(channel: HostBoundDataAttemptChannel): void {
    this.#channelAbort = (cause) => channel.abort(cause);
  }

  #completeHydration(): void {
    this.#phase = 'hydrated';
    this.#operationAbort = undefined;
    this.#unlinkExternalAbort?.();
    this.#unlinkExternalAbort = undefined;
    scrubShadowAttemptDataPlan(this.#plan, undefined, false);
    this.#plan = undefined;
    this.#clock = undefined;
  }

  #fail(cause: unknown): void {
    if (this.#phase === 'failed') return;
    this.#phase = 'failed';
    this.#failureCause = cause;
    const endpoint = this.#endpoint;
    this.#endpoint = undefined;
    this.#operationAbort?.abort(cause);
    this.#operationAbort = undefined;
    this.#unlinkExternalAbort?.();
    this.#unlinkExternalAbort = undefined;
    bestEffort(() => this.#channelAbort?.(cause));
    this.#channelAbort = undefined;
    scrubShadowAttemptDataPlan(
      this.#plan,
      cause,
      !this.#sourceTransferred,
    );
    this.#plan = undefined;
    this.#clock = undefined;
    bestEffort(() => {
      if (endpoint) assertDataCleanupDisposition(endpoint.abort(cause));
    });
  }

  #assertReady(): void {
    if (this.#phase !== 'ready') {
      throw new AttemptControlAdapterError(
        'already_opened',
        'shadow attempt data adapter is single-use',
      );
    }
  }

  #assertPhase(expected: AdapterPhase): void {
    if (this.#phase !== expected) {
      throw new AttemptControlAdapterError(
        'aborted',
        'shadow attempt data adapter lost channel ownership',
      );
    }
  }
}

function bestEffort(operation: () => void): void {
  try {
    operation();
  } catch {
    // The first protocol failure remains authoritative.
  }
}
