import {
  useNativeHostAttemptBridgeOpenRequest,
  type NativeHostAttemptBridgeOpenRequestOwner,
} from '../adapters/NativeHostAttemptBridgeRequest.js';
import { AttemptControlAdapterError } from '../adapters/AttemptControlAdapterError.js';
import {
  assertNativeHostAttemptChannels,
  type NativeHostAttemptChannels,
  type NativeHostBridgeBinding,
} from './NativeHostBridgeBinding.js';

declare const NATIVE_HOST_BRIDGE_OWNER_BRAND: unique symbol;

export interface NativeHostAttemptBridgeOwner {
  readonly [NATIVE_HOST_BRIDGE_OWNER_BRAND]: true;
}

class NativeBridgeOwner implements NativeHostAttemptBridgeOwner {
  declare readonly [NATIVE_HOST_BRIDGE_OWNER_BRAND]: true;
}

const owners = new WeakMap<object, NativeHostAttemptChannels>();

export async function openNativeHostAttemptBridge(
  binding: NativeHostBridgeBinding,
  request: NativeHostAttemptBridgeOpenRequestOwner,
): Promise<NativeHostAttemptBridgeOwner> {
  const channels = await useNativeHostAttemptBridgeOpenRequest(
    request,
    (encoded) => binding.openHostAttemptBridge(encoded),
  );
  try {
    assertNativeHostAttemptChannels(channels);
    const owner = Object.freeze(new NativeBridgeOwner());
    owners.set(owner, channels);
    return owner;
  } catch (cause) {
    await closeRejectedOwner(channels);
    throw new AttemptControlAdapterError(
      'invalid_provision',
      'native Host bridge returned an invalid channel owner',
      { cause },
    );
  }
}

export function consumeNativeHostAttemptBridge(
  owner: NativeHostAttemptBridgeOwner,
): NativeHostAttemptChannels {
  const channels = owners.get(owner);
  if (!channels) {
    throw new AttemptControlAdapterError(
      'ownership_consumed',
      'native Host bridge owner was consumed or foreign',
    );
  }
  owners.delete(owner);
  return channels;
}

export async function closeNativeHostAttemptBridge(
  owner: NativeHostAttemptBridgeOwner,
): Promise<void> {
  const channels = owners.get(owner);
  if (!channels) return;
  owners.delete(owner);
  await channels.close();
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
