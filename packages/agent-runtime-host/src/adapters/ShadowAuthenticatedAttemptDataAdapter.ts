import type {
  AuthenticatedAttemptControlContext,
  AuthenticatedAttemptDataPort,
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
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
  assertDataCleanupDisposition,
  consumeAuthenticatedAttemptDataConnection,
  consumeProtectedAttemptDataEndpoint,
  revokeAuthenticatedAttemptDataConnection,
} from './ProtectedAttemptDataEndpoint.js';
import {
  assertPhysicalAttemptDataConnection,
  bestEffort,
  createPendingHostDataChannel,
  handoffPhysicalAttemptDataTransport,
  revokePhysicalAttemptDataConnection,
} from './ShadowAttemptDataLifecycle.js';
import {
  normalizeShadowAttemptDataFailure,
} from './ShadowAttemptDataFailure.js';
import {
  type ShadowAttemptDataPlan,
  scrubShadowAttemptDataPlan,
  snapshotShadowAttemptDataPlan,
} from './ShadowAttemptDataPlan.js';
import {
  assertShadowAttemptIntegrationMode,
} from './ShadowAttemptIntegrationGate.js';
import { ShadowAttemptAbortLink } from './ShadowAttemptAbortLink.js';
import {
  type AdapterPhase,
  assertDataAdapterPhase,
} from './ShadowAttemptDataPhase.js';
import type { ShadowAuthenticatedAttemptDataAdapterOptions } from './ShadowAuthenticatedAttemptDataAdapterTypes.js';
import { ShadowAttemptProviderComposition } from './ShadowAttemptProviderComposition.js';

export type {
  ShadowAuthenticatedAttemptDataAdapterOptions,
} from './ShadowAuthenticatedAttemptDataAdapterTypes.js';

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
  readonly #cancellation = new ShadowAttemptAbortLink();
  #channelAbort?: (cause?: unknown) => void;
  #channelTerminating?: () => void;
  #sourceTransferred = false;
  #failureCause?: unknown;
  #provider?: ShadowAttemptProviderComposition;
  readonly #failureObservers = new Set<(cause: unknown) => void>();

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
      this.#provider = new ShadowAttemptProviderComposition(options);
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
    assertDataAdapterPhase(this.#phase, 'ready');
    this.#phase = 'opening';
    const plan = this.#plan!;
    let owner: AuthenticatedAttemptDataConnectionOwner | undefined;
    let connection: AuthenticatedAttemptDataConnection | undefined;
    let transport: DelimitedByteChannel | undefined;
    try {
      assertShadowAttemptIntegrationMode(context.integrationMode);
      const bound = bindDurableAttemptDataLaunch(launch, plan);
      const signal = this.#cancellation.start(
        context.signal,
        (cause) => this.abort(cause),
      );
      assertDataAdapterPhase(this.#phase, 'opening');
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
      assertDataAdapterPhase(this.#phase, 'opening');
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
      this.#ownChannel(pending);
      const channel = await pending.bind();
      assertDataAdapterPhase(this.#phase, 'binding');
      this.#phase = 'hydrating';
      this.#ownChannel(channel);
      this.#sourceTransferred = true;
      await channel.hydrate({ ...plan.hydration, signal });
      assertDataAdapterPhase(this.#phase, 'hydrating');
      const providerSession = this.#provider!.start(
        channel,
        this.#clock!,
        (cause) => this.#fail(cause),
      );
      if (providerSession) {
        this.#channelAbort = (cause) => providerSession.abort(cause);
        this.#channelTerminating = () => providerSession.beginTermination();
      }
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

  beginTermination(): void {
    this.#channelTerminating?.();
  }

  observeFailure(observer: (cause: unknown) => void): () => void {
    if (this.#phase === 'failed') {
      observer(this.#failureCause);
      return () => undefined;
    }
    this.#failureObservers.add(observer);
    return () => { this.#failureObservers.delete(observer); };
  }

  #ownChannel(channel: { abort(cause?: unknown): void }): void {
    this.#channelAbort = (cause) => channel.abort(cause);
  }

  #completeHydration(): void {
    this.#phase = 'hydrated';
    this.#cancellation.complete();
    scrubShadowAttemptDataPlan(this.#plan, undefined, false);
    this.#plan = undefined;
    this.#clock = undefined;
  }

  #fail(cause: unknown): void {
    if (this.#phase === 'failed') return;
    this.#phase = 'failed';
    this.#failureCause = cause;
    this.#provider?.clear();
    this.#provider = undefined;
    const endpoint = this.#endpoint;
    this.#endpoint = undefined;
    this.#cancellation.abort(cause);
    bestEffort(() => this.#channelAbort?.(cause));
    this.#channelAbort = undefined;
    this.#channelTerminating = undefined;
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
    for (const observer of this.#failureObservers) bestEffort(() => observer(cause));
    this.#failureObservers.clear();
  }

}
