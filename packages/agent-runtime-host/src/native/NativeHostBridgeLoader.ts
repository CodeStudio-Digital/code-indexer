import { createRequire } from 'node:module';
import { extname } from 'node:path';
import type {
  VerifiedRuntimePackage,
} from '../packaging/RuntimePackageTypes.js';
import {
  assertNativeHostBridgeBinding,
  type NativeHostBridgeBinding,
} from './NativeHostBridgeBinding.js';

const requireNative = createRequire(import.meta.url);
const loaded = new Map<string, NativeHostBridgeBinding>();

/**
 * Loads only the addon already bound to a verified runtime manifest.
 * The native path is never accepted as an independent authority.
 */
export function loadNativeHostBridge(
  runtimePackage: VerifiedRuntimePackage,
): NativeHostBridgeBinding {
  const addon = runtimePackage.binaries.hostBridge;
  if (
    addon.role !== 'hostBridge'
    || addon.file !== 'agent-host-bridge.node'
    || extname(addon.absolutePath) !== '.node'
  ) throw new TypeError('verified native Host bridge artifact is invalid');
  const cached = loaded.get(addon.absolutePath);
  if (cached) return cached;
  const binding = assertNativeHostBridgeBinding(
    requireNative(addon.absolutePath) as unknown,
    runtimePackage,
  );
  loaded.set(addon.absolutePath, binding);
  return binding;
}
