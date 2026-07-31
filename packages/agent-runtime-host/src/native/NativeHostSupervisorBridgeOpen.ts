import {
  useNativeHostSupervisorBridgeOpenRequest,
  type NativeHostSupervisorBridgeOpenRequestOwner,
} from '../adapters/NativeHostSupervisorBridgeRequest.js';
import {
  assertNativeHostSupervisorChannel,
  type NativeHostBridgeBinding,
  type NativeHostSupervisorChannel,
} from './NativeHostBridgeBinding.js';

declare const NATIVE_SUPERVISOR_OWNER_BRAND: unique symbol;

export interface NativeHostSupervisorBridgeOwner {
  readonly [NATIVE_SUPERVISOR_OWNER_BRAND]: true;
}

class NativeSupervisorOwner implements NativeHostSupervisorBridgeOwner {
  declare readonly [NATIVE_SUPERVISOR_OWNER_BRAND]: true;
}

const owners = new WeakMap<object, NativeHostSupervisorChannel>();

export async function openNativeHostSupervisorBridge(
  binding: NativeHostBridgeBinding,
  request: NativeHostSupervisorBridgeOpenRequestOwner,
): Promise<NativeHostSupervisorBridgeOwner> {
  const channel = await useNativeHostSupervisorBridgeOpenRequest(
    request,
    (encoded) => binding.openHostSupervisorBridge(encoded),
  );
  try {
    assertNativeHostSupervisorChannel(channel);
    const owner = Object.freeze(new NativeSupervisorOwner());
    owners.set(owner, channel);
    return owner;
  } catch (cause) {
    await closeRejectedOwner(channel);
    throw new TypeError(
      'native Host bridge returned an invalid supervisor owner',
      { cause },
    );
  }
}

export function consumeNativeHostSupervisorBridge(
  owner: NativeHostSupervisorBridgeOwner,
): NativeHostSupervisorChannel {
  const channel = owners.get(owner);
  if (!channel) {
    throw new TypeError(
      'native Host supervisor bridge owner was consumed or foreign',
    );
  }
  owners.delete(owner);
  return channel;
}

export async function closeNativeHostSupervisorBridge(
  owner: NativeHostSupervisorBridgeOwner,
): Promise<void> {
  const channel = owners.get(owner);
  if (!channel) return;
  owners.delete(owner);
  await channel.close();
}

async function closeRejectedOwner(value: unknown): Promise<void> {
  if (
    typeof value !== 'object'
    || value === null
    || !('close' in value)
    || typeof value.close !== 'function'
  ) return;
  try {
    await value.close.call(value);
  } catch {
    // Invalid native output remains the primary failure.
  }
}
