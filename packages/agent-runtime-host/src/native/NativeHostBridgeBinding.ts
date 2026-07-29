import type {
  VerifiedRuntimePackage,
} from '../packaging/RuntimePackageTypes.js';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { ATTEMPT_FRAME_MAX_BYTES } from '../ipc/AttemptFrameLimits.js';

export const NATIVE_HOST_BRIDGE_API_VERSION = 1;
export const MINIMUM_NODE_API_VERSION = 8;

export interface NativeHostBridgeAbi {
  readonly addonApiVersion: number;
  readonly contractSchemaVersion: number;
  readonly contractVersion: string;
  readonly minimumNodeApiVersion: number;
  readonly targetTriple: string;
}

export interface NativeHostAttemptChannels {
  readonly controlEndpointId: string;
  readonly controlConnectionId: string;
  readonly controlPeerPid: number;
  readonly controlMaximumFrameBytes: number;
  readonly dataEndpointId: string;
  readonly dataConnectionId: string;
  readonly dataPeerPid: number;
  readonly dataMaximumFrameBytes: number;
  readonly isClosed: boolean;
  readControl(maximumBytes: number): Promise<Uint8Array | null>;
  readData(maximumBytes: number): Promise<Uint8Array | null>;
  writeControl(bytes: Uint8Array): Promise<void>;
  writeData(bytes: Uint8Array): Promise<void>;
  close(): Promise<'closed'>;
}

export interface NativeHostBridgeBinding {
  nativeHostBridgeAbi(): NativeHostBridgeAbi;
  openHostAttemptBridge(
    request: Uint8Array,
  ): Promise<NativeHostAttemptChannels>;
}

export function assertNativeHostBridgeBinding(
  value: unknown,
  runtimePackage: VerifiedRuntimePackage,
): NativeHostBridgeBinding {
  if (!record(value)) throw invalid('module');
  const abiFunction = value.nativeHostBridgeAbi;
  const openFunction = value.openHostAttemptBridge;
  if (
    typeof abiFunction !== 'function'
    || typeof openFunction !== 'function'
  ) throw invalid('exports');
  const abi = abiFunction() as unknown;
  assertAbi(abi, runtimePackage);
  return Object.freeze({
    nativeHostBridgeAbi: abiFunction.bind(value),
    openHostAttemptBridge: openFunction.bind(value),
  });
}

export function assertNativeHostAttemptChannels(
  value: unknown,
): asserts value is NativeHostAttemptChannels {
  if (
    !record(value)
    || !identifier(value.controlEndpointId)
    || !identifier(value.controlConnectionId)
    || !processId(value.controlPeerPid)
    || value.controlMaximumFrameBytes
      !== ATTEMPT_FRAME_MAX_BYTES[agentV1Runtime.TransportChannel.CONTROL]
    || !identifier(value.dataEndpointId)
    || !identifier(value.dataConnectionId)
    || !processId(value.dataPeerPid)
    || value.dataMaximumFrameBytes
      !== ATTEMPT_FRAME_MAX_BYTES[agentV1Runtime.TransportChannel.DATA]
    || value.isClosed !== false
    || typeof value.readControl !== 'function'
    || typeof value.readData !== 'function'
    || typeof value.writeControl !== 'function'
    || typeof value.writeData !== 'function'
    || typeof value.close !== 'function'
  ) throw invalid('channel owner');
}

function assertAbi(
  value: unknown,
  runtimePackage: VerifiedRuntimePackage,
): asserts value is NativeHostBridgeAbi {
  const runtimeNapi = Number(process.versions.napi);
  if (
    !record(value)
    || value.addonApiVersion !== NATIVE_HOST_BRIDGE_API_VERSION
    || value.contractSchemaVersion
      !== runtimePackage.manifest.contractSchemaVersion
    || value.contractVersion !== runtimePackage.manifest.contractVersion
    || value.minimumNodeApiVersion !== MINIMUM_NODE_API_VERSION
    || value.targetTriple !== runtimePackage.manifest.targetTriple
    || !Number.isInteger(runtimeNapi)
    || runtimeNapi < MINIMUM_NODE_API_VERSION
  ) throw invalid('ABI');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function processId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function invalid(subject: string): TypeError {
  return new TypeError(`native Host bridge ${subject} is incompatible`);
}
