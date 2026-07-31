import type {
  AttemptEndpointCleanupDisposition,
} from '../adapters/ProtectedAttemptEndpoint.js';
import type {
  NativeHostAttemptChannels,
} from './NativeHostBridgeBinding.js';

let nextCleanupSequence = 1;
const activeReapers = new Map<string, Promise<void>>();

/**
 * The sole JavaScript capability over one Rust Control/Data owner. Closing
 * either transport begins one shared native cleanup operation.
 */
export class NativeHostBridgeCloseAuthority {
  readonly #cleanupId = `native-host-bridge:${process.pid}:${
    nextCleanupSequence++
  }`;
  #channels?: NativeHostAttemptChannels;
  #closing?: Promise<void>;
  #settled = false;

  constructor(channels: NativeHostAttemptChannels) {
    this.#channels = channels;
  }

  read(
    kind: 'control' | 'data',
    maximumBytes: number,
  ): Promise<Uint8Array | null> {
    const channels = this.#requireOpen();
    return kind === 'control'
      ? channels.readControl(maximumBytes)
      : channels.readData(maximumBytes);
  }

  write(
    kind: 'control' | 'data',
    bytes: Uint8Array,
  ): Promise<void> {
    const channels = this.#requireOpen();
    return kind === 'control'
      ? channels.writeControl(bytes)
      : channels.writeData(bytes);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const channels = this.#channels;
    if (!channels) return Promise.resolve();
    const operation = Promise.resolve(channels.close()).then((result) => {
      if (result !== 'closed') {
        throw new Error('native Host bridge returned an invalid close receipt');
      }
    });
    this.#closing = operation.finally(() => {
      this.#settled = true;
      this.#channels = undefined;
    });
    retainReaper(this.#cleanupId, this.#closing);
    return this.#closing;
  }

  beginCleanup(): AttemptEndpointCleanupDisposition {
    if (this.#settled) {
      return { kind: 'closed' };
    }
    void this.close().catch(() => undefined);
    return {
      kind: 'native_reaper',
      cleanupId: this.#cleanupId,
    };
  }

  get isClosing(): boolean {
    return this.#closing !== undefined || this.#settled;
  }

  #requireOpen(): NativeHostAttemptChannels {
    if (this.isClosing || !this.#channels || this.#channels.isClosed) {
      throw new Error('native Host bridge is closed');
    }
    return this.#channels;
  }
}

function retainReaper(cleanupId: string, operation: Promise<void>): void {
  activeReapers.set(cleanupId, operation);
  void operation.then(
    () => activeReapers.delete(cleanupId),
    () => activeReapers.delete(cleanupId),
  );
}
