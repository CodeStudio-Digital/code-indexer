import type {
  AuthenticatedAttemptControlContext,
  AuthenticatedAttemptControlPort,
  AuthenticatedAttemptLifecyclePort,
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';
import {
  awaitAuthenticatedAttemptControlConnection,
} from './AttemptControlOpenSettlement.js';
import {
  bindDurableAttemptControlLaunch,
} from './DurableAttemptControlBinding.js';
import {
  type AuthenticatedAttemptControlConnection,
  type AuthenticatedAttemptControlConnectionOwner,
  type ProtectedAttemptControlEndpoint,
  type ProtectedAttemptControlEndpointOwner,
  assertCleanupDisposition,
  consumeAuthenticatedAttemptControlConnection,
  consumeProtectedAttemptControlEndpoint,
  revokeAuthenticatedAttemptControlConnection,
} from './ProtectedAttemptControlEndpoint.js';
import {
  assertPhysicalAttemptControlConnection,
  createBoundAttemptLifecycle,
  handoffPhysicalAttemptControlTransport,
  revokePhysicalAttemptControlConnection,
} from './ShadowAttemptControlLifecycle.js';
import {
  type ShadowAttemptControlPlan,
  type ShadowAttemptControlPlanInput,
  scrubShadowAttemptControlPlan,
  snapshotShadowAttemptControlPlan,
} from './ShadowAttemptControlPlan.js';
import {
  assertShadowAttemptIntegrationMode,
} from './ShadowAttemptIntegrationGate.js';

type AdapterPhase = 'ready' | 'opening' | 'handed_off' | 'failed';

export interface ShadowAuthenticatedAttemptControlAdapterOptions
extends ShadowAttemptControlPlanInput {
  readonly endpoint: ProtectedAttemptControlEndpointOwner;
}

/**
 * Internal test/shadow composition. The adapter consumes one protected
 * endpoint owner and transfers its authenticated transport directly into the
 * lifecycle driver only after binding all durable supervisor facts.
 */
export class ShadowAuthenticatedAttemptControlAdapter
implements AuthenticatedAttemptControlPort {
  #endpoint?: ProtectedAttemptControlEndpoint;
  #plan?: ShadowAttemptControlPlan;
  #phase: AdapterPhase = 'ready';
  #openingAbort?: AbortController;
  #unlinkExternalAbort?: () => void;

  constructor(options: ShadowAuthenticatedAttemptControlAdapterOptions) {
    const endpoint = consumeProtectedAttemptControlEndpoint(options.endpoint);
    try {
      this.#plan = snapshotShadowAttemptControlPlan(options);
      this.#endpoint = endpoint;
    } catch (cause) {
      bestEffort(() => assertCleanupDisposition(endpoint.abort(cause)));
      throw cause;
    }
  }

  async open(
    launch: DurableSupervisorLaunchSnapshot,
    context: AuthenticatedAttemptControlContext,
  ): Promise<AuthenticatedAttemptLifecyclePort> {
    this.#assertReady();
    this.#phase = 'opening';
    const plan = this.#plan!;
    let owner: AuthenticatedAttemptControlConnectionOwner | undefined;
    let connection: AuthenticatedAttemptControlConnection | undefined;
    let transport: DelimitedByteChannel | undefined;
    try {
      assertShadowAttemptIntegrationMode(context.integrationMode);
      const bound = bindDurableAttemptControlLaunch(launch, plan);
      const signal = this.#startCancellation(context.signal);
      this.#assertOpening();
      const operation = this.#endpoint!.open({
        endpointId: plan.endpointId,
        connectionId: plan.connectionId,
        reservationId: bound.reservationId,
        resourceGroupId: bound.resourceGroupId,
        expectedPeerPid: bound.runnerProvenance.pid,
        maximumFrameBytes: 256 * 1024,
        deadlineAtUnixMs: plan.specDeadlineAtUnixMs,
        signal,
      });
      owner = await awaitAuthenticatedAttemptControlConnection(
        operation,
        signal,
      );
      this.#assertOpening();
      connection = consumeAuthenticatedAttemptControlConnection(owner);
      owner = undefined;
      assertPhysicalAttemptControlConnection(connection, plan, bound);
      this.#assertOpening();
      transport = handoffPhysicalAttemptControlTransport(connection);
      connection = undefined;
      this.#assertOpening();
      const lifecycle = createBoundAttemptLifecycle(transport, plan, bound);
      transport = undefined;
      this.#completeHandoff();
      return lifecycle;
    } catch (cause) {
      if (owner) {
        revokeAuthenticatedAttemptControlConnection(owner, cause);
      }
      if (connection) {
        revokePhysicalAttemptControlConnection(connection, cause);
      }
      if (transport) bestEffort(() => transport?.fail(cause));
      this.#fail(cause);
      throw normalizeFailure(cause);
    }
  }

  abort(cause?: unknown): void {
    this.#fail(new AttemptControlAdapterError(
      'aborted',
      'shadow attempt control adapter was aborted',
      cause === undefined ? undefined : { cause },
    ));
  }

  #startCancellation(external: AbortSignal): AbortSignal {
    const controller = new AbortController();
    this.#openingAbort = controller;
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

  #completeHandoff(): void {
    this.#phase = 'handed_off';
    this.#endpoint = undefined;
    this.#openingAbort = undefined;
    this.#unlinkExternalAbort?.();
    this.#unlinkExternalAbort = undefined;
    scrubShadowAttemptControlPlan(this.#plan);
    this.#plan = undefined;
  }

  #fail(cause: unknown): void {
    if (this.#phase === 'failed' || this.#phase === 'handed_off') return;
    this.#phase = 'failed';
    const endpoint = this.#endpoint;
    this.#endpoint = undefined;
    this.#openingAbort?.abort(cause);
    this.#openingAbort = undefined;
    this.#unlinkExternalAbort?.();
    this.#unlinkExternalAbort = undefined;
    scrubShadowAttemptControlPlan(this.#plan);
    this.#plan = undefined;
    bestEffort(() => {
      if (endpoint) assertCleanupDisposition(endpoint.abort(cause));
    });
  }

  #assertReady(): void {
    if (this.#phase !== 'ready') {
      throw new AttemptControlAdapterError(
        'already_opened',
        'shadow attempt control adapter is single-use',
      );
    }
  }

  #assertOpening(): void {
    if (this.#phase !== 'opening') {
      throw new AttemptControlAdapterError(
        'aborted',
        'shadow attempt control adapter lost endpoint ownership',
      );
    }
  }
}

function normalizeFailure(cause: unknown): AttemptControlAdapterError {
  return cause instanceof AttemptControlAdapterError
    ? cause
    : new AttemptControlAdapterError(
      'invalid_connection',
      'shadow attempt control open failed closed',
      { cause },
    );
}

function bestEffort(operation: () => void): void {
  try {
    operation();
  } catch {
    // The first protocol failure remains authoritative.
  }
}
