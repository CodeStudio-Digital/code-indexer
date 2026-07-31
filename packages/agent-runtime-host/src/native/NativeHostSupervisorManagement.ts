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
 * Launches the process-real supervisor and transfers its exact native stream
 * into the existing semantic management bootstrap.
 */
export async function createNativeHostSupervisorManagementBootstrap(
  options: NativeHostSupervisorManagementOptions,
): Promise<HostSupervisorManagementBootstrap> {
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
      return new HostSupervisorManagementBootstrap(
        transport,
        options.provision,
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

function safeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number <= 0
    || number > 0xffff_ffff
  ) throw new RangeError(`native supervisor ${field} is invalid`);
  return number;
}
