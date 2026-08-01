import {
  abortNativeHostSupervisorBridgeOpenRequest,
  encodeNativeHostSupervisorBridgeOpenRequest,
} from '../adapters/NativeHostSupervisorBridgeRequest.js';
import type {
  HostSupervisorBootstrapProvision,
} from '../ipc/HostSupervisorBootstrapTypes.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  HostSupervisorManagementBootstrap,
} from '../ipc/HostSupervisorManagementBootstrap.js';
import type {
  VerifiedRuntimePackage,
} from '../packaging/RuntimePackageTypes.js';
import type {
  NativeHostSupervisorCloseReceipt,
  NativeHostBridgeBinding,
} from './NativeHostBridgeBinding.js';
import {
  consumeNativeHostSupervisorBridge,
  openNativeHostSupervisorBridge,
} from './NativeHostSupervisorBridgeOpen.js';
import {
  NativeHostSupervisorCloseAuthority,
} from './NativeHostSupervisorClose.js';
import {
  NativeHostSupervisorDuplex,
} from './NativeHostSupervisorDuplex.js';

export interface NativeHostSupervisorManagementOptions {
  readonly binding: NativeHostBridgeBinding;
  readonly runtimePackage: VerifiedRuntimePackage;
  readonly provision: HostSupervisorBootstrapProvision;
}

/**
 * Process owner for one native supervisor management session.
 *
 * The semantic bootstrap is deliberately single-use, while this owner remains
 * available until native close has returned process-reap evidence. Keeping the
 * two lifetimes together prevents a detached launch capability from hiding the
 * only authority able to terminate the supervisor and its runner Job Object.
 */
export interface NativeHostSupervisorManagementOwner {
  readonly supervisorProcessId: number;
  establish(): ReturnType<HostSupervisorManagementBootstrap['establish']>;
  abort(cause?: unknown): void;
  close(): Promise<NativeHostSupervisorCloseReceipt>;
}

/**
 * Launches the process-real supervisor and transfers its exact native stream
 * into the existing semantic management bootstrap.
 */
export async function createNativeHostSupervisorManagementBootstrap(
  options: NativeHostSupervisorManagementOptions,
): Promise<NativeHostSupervisorManagementOwner> {
  const request = encodeNativeHostSupervisorBridgeOpenRequest({
    runtimePackage: options.runtimePackage,
    provision: options.provision,
  });
  let transferred = false;
  try {
    const owner = await openNativeHostSupervisorBridge(
      options.binding,
      request,
    );
    transferred = true;
    const channel = consumeNativeHostSupervisorBridge(owner);
    if (
      channel.managementConnectionId
      !== options.provision.expectedConnectionId
    ) {
      await channel.close();
      throw new TypeError(
        'native supervisor connection ID diverges from Host authority',
      );
    }
    const limits = options.provision.hostHello.frameLimits;
    if (!limits) {
      await channel.close();
      throw new TypeError('native supervisor frame limits are absent');
    }
    const chunkBytes = safeNumber(limits.maxChunkBytes, 'maxChunkBytes');
    const authority = new NativeHostSupervisorCloseAuthority(channel);
    try {
      const duplex = new NativeHostSupervisorDuplex(authority, chunkBytes);
      const transport = new DelimitedByteChannel(duplex, duplex, {
        maximumFrameBytes: channel.managementMaximumFrameBytes,
        maximumTransportChunkBytes: chunkBytes,
        readTimeoutMs: safeNumber(limits.readTimeoutMs, 'readTimeoutMs'),
        writeTimeoutMs: safeNumber(limits.writeTimeoutMs, 'writeTimeoutMs'),
      });
      const bootstrap = new HostSupervisorManagementBootstrap(
        transport,
        options.provision,
      );
      return new OwnedNativeHostSupervisorManagement(
        bootstrap,
        authority,
        channel.supervisorProcessId,
      );
    } catch (cause) {
      await authority.close().catch(() => undefined);
      throw cause;
    }
  } finally {
    if (!transferred) {
      abortNativeHostSupervisorBridgeOpenRequest(request);
    }
  }
}

class OwnedNativeHostSupervisorManagement
implements NativeHostSupervisorManagementOwner {
  readonly supervisorProcessId: number;
  readonly #bootstrap: HostSupervisorManagementBootstrap;
  readonly #authority: NativeHostSupervisorCloseAuthority;

  constructor(
    bootstrap: HostSupervisorManagementBootstrap,
    authority: NativeHostSupervisorCloseAuthority,
    supervisorProcessId: number,
  ) {
    this.#bootstrap = bootstrap;
    this.#authority = authority;
    this.supervisorProcessId = supervisorProcessId;
  }

  establish(): ReturnType<HostSupervisorManagementBootstrap['establish']> {
    return this.#bootstrap.establish();
  }

  abort(cause?: unknown): void {
    this.#bootstrap.abort(cause);
    void this.#authority.close().catch(() => undefined);
  }

  close(): Promise<NativeHostSupervisorCloseReceipt> {
    this.#bootstrap.abort(new Error(
      'native Host supervisor owner closed before bootstrap completion',
    ));
    return this.#authority.close();
  }
}

function safeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number <= 0
    || number > 0xffff_ffff
  ) throw new RangeError(`native supervisor ${field} is invalid`);
  return number;
}
