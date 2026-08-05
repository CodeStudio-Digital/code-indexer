import {
  type AuthenticatedAttemptControlContext,
  type AuthenticatedAttemptControlPort,
  type AuthenticatedAttemptDataPort,
  type AuthenticatedAttemptLifecyclePort,
  type DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import {
  ShadowAuthenticatedAttemptControlAdapter,
  type ShadowAuthenticatedAttemptControlAdapterOptions,
} from '../adapters/ShadowAuthenticatedAttemptControlAdapter.js';
import {
  ShadowAuthenticatedAttemptDataAdapter,
  type ShadowAuthenticatedAttemptDataAdapterOptions,
} from '../adapters/ShadowAuthenticatedAttemptDataAdapter.js';
import {
  validateAttemptEndpointPlan,
} from '../adapters/ShadowAttemptControlEndpointPlan.js';
import {
  deriveShadowAttemptDataFrameLimits,
} from '../adapters/ShadowAttemptDataPlanValidation.js';
import type {
  NativeHostBridgeBinding,
} from './NativeHostBridgeBinding.js';
import {
  NativeHostAttemptEndpointPair,
} from './NativeHostAttemptEndpointPair.js';

type NativeControlOptions = Omit<
  ShadowAuthenticatedAttemptControlAdapterOptions,
  'endpoint' | 'launch'
>;
type NativeDataOptions = Omit<
  ShadowAuthenticatedAttemptDataAdapterOptions,
  'endpoint' | 'launch'
>;

export interface NativeShadowAttemptAdaptersOptions {
  readonly binding: NativeHostBridgeBinding;
  readonly launch: ShadowAuthenticatedAttemptControlAdapterOptions['launch'];
  readonly openDeadlineAtUnixMs: bigint;
  readonly control: NativeControlOptions;
  readonly data: NativeDataOptions;
}

export interface NativeShadowAttemptAdapters {
  readonly control: AuthenticatedAttemptControlPort;
  readonly data: AuthenticatedAttemptDataPort;
}

/**
 * Internal native composition for the existing test/shadow lifecycle. The
 * semantic adapters remain unchanged; only their physical endpoints are
 * supplied by the single Rust owner.
 */
export function createNativeShadowAttemptAdapters(
  options: NativeShadowAttemptAdaptersOptions,
): NativeShadowAttemptAdapters {
  const controlLimits = options.control.hostHello.frameLimits;
  const budget = options.launch.resourceBudget;
  if (!controlLimits || !budget) {
    throw new RangeError('native attempt transport limits');
  }
  const endpoints = validateAttemptEndpointPlan(
    options.launch.protectedEndpoints,
  );
  const dataLimits = deriveShadowAttemptDataFrameLimits(
    endpoints.data.maxFrameBytes,
    budget,
  );
  const pair = new NativeHostAttemptEndpointPair({
    binding: options.binding,
    launch: options.launch,
    openDeadlineAtUnixMs: options.openDeadlineAtUnixMs,
    requiredContainmentLevel: options.control.requiredContainmentLevel,
    controlTiming: {
      readTimeoutMs: Number(controlLimits.readTimeoutMs),
      writeTimeoutMs: Number(controlLimits.writeTimeoutMs),
    },
    dataTiming: {
      readTimeoutMs: Number(dataLimits.readTimeoutMs),
      writeTimeoutMs: Number(dataLimits.writeTimeoutMs),
    },
  });
  const protectedEndpoints = pair.endpoints();
  try {
    const control = new ShadowAuthenticatedAttemptControlAdapter({
      ...options.control,
      launch: options.launch,
      endpoint: protectedEndpoints.control,
    });
    const data = new ShadowAuthenticatedAttemptDataAdapter({
      ...options.data,
      launch: options.launch,
      endpoint: protectedEndpoints.data,
    });
    return Object.freeze({
      control: new NativeControlAdapter(control, pair),
      data: new NativeDataAdapter(data, pair),
    });
  } catch (cause) {
    pair.abort(cause);
    throw cause;
  }
}

class NativeControlAdapter implements AuthenticatedAttemptControlPort {
  readonly #delegate: ShadowAuthenticatedAttemptControlAdapter;
  readonly #pair: NativeHostAttemptEndpointPair;

  constructor(
    delegate: ShadowAuthenticatedAttemptControlAdapter,
    pair: NativeHostAttemptEndpointPair,
  ) {
    this.#delegate = delegate;
    this.#pair = pair;
  }

  async open(
    launch: DurableSupervisorLaunchSnapshot,
    context: AuthenticatedAttemptControlContext,
  ): Promise<AuthenticatedAttemptLifecyclePort> {
    try {
      this.#pair.prepare(launch);
      return await this.#delegate.open(launch, context);
    } catch (cause) {
      this.#pair.abort(cause);
      throw cause;
    }
  }

  abort(cause?: unknown): void {
    this.#delegate.abort(cause);
    this.#pair.abort(cause);
  }
}

class NativeDataAdapter implements AuthenticatedAttemptDataPort {
  readonly #delegate: ShadowAuthenticatedAttemptDataAdapter;
  readonly #pair: NativeHostAttemptEndpointPair;

  constructor(
    delegate: ShadowAuthenticatedAttemptDataAdapter,
    pair: NativeHostAttemptEndpointPair,
  ) {
    this.#delegate = delegate;
    this.#pair = pair;
  }

  async hydrate(
    launch: DurableSupervisorLaunchSnapshot,
    context: AuthenticatedAttemptControlContext,
  ): Promise<void> {
    try {
      await this.#delegate.hydrate(launch, context);
    } catch (cause) {
      this.#pair.abort(cause);
      throw cause;
    }
  }

  observeFailure(observer: (cause: unknown) => void): () => void {
    return this.#delegate.observeFailure(observer);
  }

  beginTermination(): void {
    this.#delegate.beginTermination();
  }

  abort(cause?: unknown): void {
    this.#delegate.abort(cause);
    this.#pair.abort(cause);
  }
}
