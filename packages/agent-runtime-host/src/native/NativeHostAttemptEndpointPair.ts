import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import {
  abortNativeHostAttemptBridgeOpenRequest,
  encodeNativeHostAttemptBridgeOpenRequest,
  type NativeHostAttemptBridgeOpenRequestOwner,
} from '../adapters/NativeHostAttemptBridgeRequest.js';
import { AttemptControlAdapterError } from '../adapters/AttemptControlAdapterError.js';
import {
  type AttemptEndpointCleanupDisposition,
  type AuthenticatedAttemptConnection,
  type ProtectedAttemptEndpointOpenExpectation,
} from '../adapters/ProtectedAttemptEndpoint.js';
import {
  ownAuthenticatedAttemptControlConnection,
  ownProtectedAttemptControlEndpoint,
  type ProtectedAttemptControlEndpointOwner,
} from '../adapters/ProtectedAttemptControlEndpoint.js';
import {
  ownAuthenticatedAttemptDataConnection,
  ownProtectedAttemptDataEndpoint,
  type ProtectedAttemptDataEndpointOwner,
} from '../adapters/ProtectedAttemptDataEndpoint.js';
import type {
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import type {
  NativeHostBridgeBinding,
} from './NativeHostBridgeBinding.js';
import {
  createNativeHostAttemptConnections,
  type NativeHostAttemptConnectionPair,
  type NativeHostChannelTiming,
} from './NativeHostBridgeConnections.js';
import {
  assertNativeHostExpectedConnection,
  scrubNativeHostLaunch,
} from './NativeHostEndpointExpectation.js';
import {
  closeNativeHostAttemptBridge,
  consumeNativeHostAttemptBridge,
  openNativeHostAttemptBridge,
  type NativeHostAttemptBridgeOwner,
} from './NativeHostBridgeOpen.js';

type PairPhase = 'ready' | 'prepared' | 'opening' | 'opened' | 'failed';
let nextPairSequence = 1;

export interface NativeHostAttemptEndpointPairOptions {
  readonly binding: NativeHostBridgeBinding;
  readonly launch: agentV1Supervisor.LaunchAttemptProcess;
  readonly openDeadlineAtUnixMs: bigint;
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
  readonly controlTiming: NativeHostChannelTiming;
  readonly dataTiming: NativeHostChannelTiming;
}

/** Opens both native channels once, then hands each to the existing adapters. */
export class NativeHostAttemptEndpointPair {
  readonly #binding;
  readonly #openDeadlineAtUnixMs;
  readonly #requiredContainmentLevel;
  readonly #timing;
  readonly #cleanupId = `native-host-open:${process.pid}:${nextPairSequence++}`;
  #launch?: agentV1Supervisor.LaunchAttemptProcess;
  #request?: NativeHostAttemptBridgeOpenRequestOwner;
  #nativeOwner?: NativeHostAttemptBridgeOwner;
  #connections?: NativeHostAttemptConnectionPair;
  #data?: AuthenticatedAttemptConnection;
  #phase: PairPhase = 'ready';
  #nativeOpenPending = false;
  #cause?: unknown;

  constructor(options: NativeHostAttemptEndpointPairOptions) {
    this.#binding = options.binding;
    this.#openDeadlineAtUnixMs = options.openDeadlineAtUnixMs;
    this.#requiredContainmentLevel = options.requiredContainmentLevel;
    this.#timing = Object.freeze({
      control: Object.freeze({ ...options.controlTiming }),
      data: Object.freeze({ ...options.dataTiming }),
    });
    this.#launch = clone(
      agentV1Supervisor.LaunchAttemptProcessSchema,
      options.launch,
    );
  }

  endpoints(): {
    readonly control: ProtectedAttemptControlEndpointOwner;
    readonly data: ProtectedAttemptDataEndpointOwner;
  } {
    return Object.freeze({
      control: ownProtectedAttemptControlEndpoint({
        open: (expectation) => this.#openControl(expectation),
        abort: (cause) => this.abort(cause),
      }),
      data: ownProtectedAttemptDataEndpoint({
        open: (expectation) => this.#openData(expectation),
        abort: (cause) => this.abort(cause),
      }),
    });
  }

  prepare(durable: DurableSupervisorLaunchSnapshot): void {
    if (this.#phase !== 'ready' || !this.#launch) throw invalid(
      'native Host endpoint pair cannot be prepared twice',
    );
    try {
      this.#request = encodeNativeHostAttemptBridgeOpenRequest({
        launch: this.#launch,
        durable,
        openDeadlineAtUnixMs: this.#openDeadlineAtUnixMs,
        requiredContainmentLevel: this.#requiredContainmentLevel,
      });
      this.#phase = 'prepared';
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    } finally {
      scrubNativeHostLaunch(this.#launch);
      this.#launch = undefined;
    }
  }

  abort(cause?: unknown): AttemptEndpointCleanupDisposition {
    if (this.#phase !== 'failed') this.#fail(cause);
    const disposition = this.#connections?.authority.beginCleanup();
    if (disposition) return disposition;
    if (this.#nativeOpenPending || this.#nativeOwner) {
      void this.#closeNativeOwner();
      return { kind: 'native_reaper', cleanupId: this.#cleanupId };
    }
    return { kind: 'closed' };
  }

  async #openControl(
    expectation: ProtectedAttemptEndpointOpenExpectation,
  ) {
    if (this.#phase !== 'prepared' || !this.#request) {
      throw invalid('native Control endpoint was not prepared');
    }
    if (expectation.signal.aborted) {
      this.#fail(expectation.signal.reason);
      throw aborted(expectation.signal.reason);
    }
    const request = this.#request;
    this.#request = undefined;
    this.#phase = 'opening';
    this.#nativeOpenPending = true;
    try {
      const owner = await openNativeHostAttemptBridge(this.#binding, request);
      this.#nativeOpenPending = false;
      this.#nativeOwner = owner;
      if (this.#phase !== 'opening' || expectation.signal.aborted) {
        await this.#closeNativeOwner();
        throw aborted(this.#cause ?? expectation.signal.reason);
      }
      const channels = consumeNativeHostAttemptBridge(owner);
      this.#nativeOwner = undefined;
      const connections = createNativeHostAttemptConnections(
        channels,
        this.#timing,
      );
      this.#connections = connections;
      assertNativeHostExpectedConnection(connections.control, expectation);
      this.#data = connections.data;
      this.#phase = 'opened';
      return ownAuthenticatedAttemptControlConnection(connections.control);
    } catch (cause) {
      this.#nativeOpenPending = false;
      this.#fail(cause);
      throw cause instanceof AttemptControlAdapterError
        ? cause
        : invalid('native Control endpoint open failed', cause);
    }
  }

  async #openData(
    expectation: ProtectedAttemptEndpointOpenExpectation,
  ) {
    const data = this.#data;
    if (this.#phase !== 'opened' || !data) {
      throw invalid('native Data endpoint is unavailable');
    }
    try {
      assertNativeHostExpectedConnection(data, expectation);
      this.#data = undefined;
      return ownAuthenticatedAttemptDataConnection(data);
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    }
  }

  #fail(cause: unknown): void {
    if (this.#phase === 'failed') return;
    const previous = this.#phase;
    this.#phase = 'failed';
    this.#cause = cause;
    scrubNativeHostLaunch(this.#launch);
    this.#launch = undefined;
    if (this.#request) {
      abortNativeHostAttemptBridgeOpenRequest(this.#request);
      this.#request = undefined;
    }
    if (previous === 'opened') {
      try {
        this.#data?.revokeBeforeHandoff(cause);
      } catch {
        // Shared native close below remains the cleanup authority.
      }
      this.#data = undefined;
    }
    this.#connections?.authority.beginCleanup();
    void this.#closeNativeOwner();
  }

  async #closeNativeOwner(): Promise<void> {
    const owner = this.#nativeOwner;
    if (!owner) return;
    this.#nativeOwner = undefined;
    await closeNativeHostAttemptBridge(owner);
  }
}

function invalid(message: string, cause?: unknown): AttemptControlAdapterError {
  return new AttemptControlAdapterError(
    'invalid_provision',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function aborted(cause: unknown): AttemptControlAdapterError {
  return new AttemptControlAdapterError(
    'aborted',
    'native Host endpoint pair was aborted',
    { cause },
  );
}
