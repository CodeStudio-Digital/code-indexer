import { createRequire } from 'node:module';
import {
  loadNativeHostBridge,
} from '../../packages/agent-runtime-host/src/native/index.js';
import {
  verifyRuntimePackage,
  type RuntimePackageAnchor,
} from '../../packages/agent-runtime-host/src/index.js';

const packageDirectory = process.argv[2];
const anchor = parseAnchor(process.argv[3]);
const verified = await verifyRuntimePackage(packageDirectory, anchor);
const bridge = loadNativeHostBridge(verified);
assertOwnerCannotBeForged(verified.binaries.hostBridge.absolutePath);
const abi = bridge.nativeHostBridgeAbi();
if (abi.targetTriple !== verified.manifest.targetTriple) {
  throw new Error('native Host bridge smoke observed a target mismatch');
}
const malformed = Buffer.from([0x08, 0x01]);
let rejected = false;
try {
  await bridge.openHostAttemptBridge(malformed);
} catch {
  rejected = true;
}
if (!rejected || malformed.some((byte) => byte !== 0)) {
  throw new Error('native Host bridge malformed request did not fail closed');
}
process.stdout.write('NATIVE_HOST_BRIDGE_SMOKE_OK\n');

function assertOwnerCannotBeForged(addonPath: string): void {
  const raw = createRequire(import.meta.url)(addonPath) as {
    NativeHostAttemptChannels?: new () => unknown;
  };
  if (typeof raw.NativeHostAttemptChannels !== 'function') {
    throw new Error('native Host bridge owner class is missing');
  }
  try {
    Reflect.construct(raw.NativeHostAttemptChannels, []);
  } catch {
    return;
  }
  throw new Error('native Host bridge owner can be forged from JavaScript');
}

function parseAnchor(value: string | undefined): RuntimePackageAnchor {
  if (!value) throw new TypeError('native addon smoke anchor is missing');
  return JSON.parse(value) as RuntimePackageAnchor;
}
