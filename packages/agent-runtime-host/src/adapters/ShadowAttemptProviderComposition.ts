import type { AuthorityClock } from '../ipc/AttemptClock.js';
import type { HostBoundDataAttemptChannel } from '../ipc/HostDataAttemptChannel.js';
import type { ShadowAuthenticatedAttemptDataAdapterOptions } from './ShadowAuthenticatedAttemptDataAdapterTypes.js';

export interface OwnedShadowProviderSession {
  abort(cause?: unknown): void;
  beginTermination(): void;
}

export class ShadowAttemptProviderComposition {
  #provider?: ShadowAuthenticatedAttemptDataAdapterOptions['providerGateway'];
  #providerFactory?: ShadowAuthenticatedAttemptDataAdapterOptions['providerGatewayFactory'];
  #eventCommitter?: ShadowAuthenticatedAttemptDataAdapterOptions['engineEventCommitter'];
  #capability?: ShadowAuthenticatedAttemptDataAdapterOptions['capabilityGateway'];
  #capabilityFactory?: ShadowAuthenticatedAttemptDataAdapterOptions['capabilityGatewayFactory'];

  constructor(options: ShadowAuthenticatedAttemptDataAdapterOptions) {
    this.#provider = options.providerGateway;
    this.#providerFactory = options.providerGatewayFactory;
    this.#eventCommitter = options.engineEventCommitter;
    this.#capability = options.capabilityGateway;
    this.#capabilityFactory = options.capabilityGatewayFactory;
    if (this.#provider && this.#providerFactory) {
      throw new RangeError('provider gateway authority is ambiguous');
    }
    if (this.#capability && this.#capabilityFactory) {
      throw new RangeError('capability gateway authority is ambiguous');
    }
  }

  start(
    channel: HostBoundDataAttemptChannel,
    clock: AuthorityClock,
    onFailure: (cause: unknown) => void,
  ): OwnedShadowProviderSession | undefined {
    const provider = this.#provider
      ?? this.#providerFactory?.(channel.context, clock);
    if (!provider) {
      this.clear();
      return;
    }
    const capability = this.#capability
      ?? this.#capabilityFactory?.(channel.context, clock);
    const session = channel.intoProviderSession(
      provider,
      this.#eventCommitter,
      capability,
    );
    this.clear();
    const abortController = new AbortController();
    void session.run(abortController.signal).catch(onFailure);
    return {
      abort(cause) {
        abortController.abort(cause);
        session.abort(cause);
      },
      beginTermination() { session.beginTermination(); },
    };
  }

  clear(): void {
    this.#provider = undefined;
    this.#providerFactory = undefined;
    this.#eventCommitter = undefined;
    this.#capability = undefined;
    this.#capabilityFactory = undefined;
  }
}
