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
let rejectedAttempt = false;
try {
  await bridge.openHostAttemptBridge(malformed);
} catch {
  rejectedAttempt = true;
}
if (!rejectedAttempt || malformed.some((byte) => byte !== 0)) {
  throw new Error('native Host bridge malformed request did not fail closed');
}
const malformedSupervisor = Buffer.from([0x08, 0x01]);
let rejectedSupervisor = false;
try {
  await bridge.openHostSupervisorBridge(malformedSupervisor);
} catch {
  rejectedSupervisor = true;
}
if (
  !rejectedSupervisor
  || malformedSupervisor.some((byte) => byte !== 0)
) {
  throw new Error(
    'native Host supervisor bridge malformed request did not fail closed',
  );
}
process.stdout.write('NATIVE_HOST_BRIDGE_SMOKE_OK\n');

function assertOwnerCannotBeForged(addonPath: string): void {
  const raw = createRequire(import.meta.url)(addonPath) as {
    NativeHostAttemptChannels?: new () => unknown;
    NativeHostSupervisorChannel?: new () => unknown;
  };
  assertNotConstructible(
    raw.NativeHostAttemptChannels,
    'native Host bridge attempt owner',
  );
  assertNotConstructible(
    raw.NativeHostSupervisorChannel,
    'native Host bridge supervisor owner',
  );
}

function assertNotConstructible(
  owner: (new () => unknown) | undefined,
  label: string,
): void {
  if (typeof owner !== 'function') throw new Error(`${label} class is missing`);
  try {
    Reflect.construct(owner, []);
  } catch {
    return;
  }
  throw new Error(`${label} can be forged from JavaScript`);
}

function parseAnchor(value: string | undefined): RuntimePackageAnchor {
  if (!value) throw new TypeError('native addon smoke anchor is missing');
  return JSON.parse(value) as RuntimePackageAnchor;
}
