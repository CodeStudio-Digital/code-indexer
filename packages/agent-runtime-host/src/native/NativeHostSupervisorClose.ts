import {
  assertNativeHostSupervisorCloseReceipt,
  type NativeHostSupervisorChannel,
  type NativeHostSupervisorCloseReceipt,
} from './NativeHostBridgeBinding.js';

let nextCleanupSequence = 1;
const activeReapers = new Map<string, Promise<NativeHostSupervisorCloseReceipt>>();

/** Sole JavaScript capability over one native management/process owner. */
export class NativeHostSupervisorCloseAuthority {
  readonly #cleanupId = `native-host-supervisor:${process.pid}:${
    nextCleanupSequence++
  }`;
  readonly #processId: number;
  #channel?: NativeHostSupervisorChannel;
  #closing?: Promise<NativeHostSupervisorCloseReceipt>;

  constructor(channel: NativeHostSupervisorChannel) {
    this.#channel = channel;
    this.#processId = channel.supervisorProcessId;
  }

  read(maximumBytes: number): Promise<Uint8Array | null> {
    return this.#requireOpen().readManagement(maximumBytes);
  }

  write(bytes: Uint8Array): Promise<void> {
    return this.#requireOpen().writeManagement(bytes);
  }

  close(): Promise<NativeHostSupervisorCloseReceipt> {
    if (this.#closing) return this.#closing;
    const channel = this.#channel;
    if (!channel) {
      return Promise.reject(new Error(
        'native Host supervisor close authority is unavailable',
      ));
    }
    this.#closing = Promise.resolve(channel.close()).then((receipt) => {
      assertNativeHostSupervisorCloseReceipt(receipt, this.#processId);
      return receipt;
    }).finally(() => {
      this.#channel = undefined;
    });
    activeReapers.set(this.#cleanupId, this.#closing);
    void this.#closing.then(
      () => activeReapers.delete(this.#cleanupId),
      () => activeReapers.delete(this.#cleanupId),
    );
    return this.#closing;
  }

  get isClosing(): boolean {
    return this.#closing !== undefined || !this.#channel;
  }

  #requireOpen(): NativeHostSupervisorChannel {
    if (this.isClosing || !this.#channel || this.#channel.isClosed) {
      throw new Error('native Host supervisor bridge is closed');
    }
    return this.#channel;
  }
}
