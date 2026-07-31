import type {
  VerifiedRuntimePackage,
} from '../packaging/RuntimePackageTypes.js';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { ATTEMPT_FRAME_MAX_BYTES } from '../ipc/AttemptFrameLimits.js';
import { MANAGEMENT_FRAME_MAX_BYTES } from '../ipc/ManagementFrame.js';

export const NATIVE_HOST_BRIDGE_API_VERSION = 2;
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

export interface NativeHostSupervisorCloseReceipt {
  readonly processId: number;
  readonly exitCode: number;
  readonly forced: boolean;
}

export interface NativeHostSupervisorChannel {
  readonly managementConnectionId: string;
  readonly managementMaximumFrameBytes: number;
  readonly supervisorProcessId: number;
  readonly isClosed: boolean;
  readManagement(maximumBytes: number): Promise<Uint8Array | null>;
  writeManagement(bytes: Uint8Array): Promise<void>;
  close(): Promise<NativeHostSupervisorCloseReceipt>;
}

export interface NativeHostBridgeBinding {
  nativeHostBridgeAbi(): NativeHostBridgeAbi;
  openHostAttemptBridge(
    request: Uint8Array,
  ): Promise<NativeHostAttemptChannels>;
  openHostSupervisorBridge(
    request: Uint8Array,
  ): Promise<NativeHostSupervisorChannel>;
}

export function assertNativeHostBridgeBinding(
  value: unknown,
  runtimePackage: VerifiedRuntimePackage,
): NativeHostBridgeBinding {
  if (!record(value)) throw invalid('module');
  const abiFunction = value.nativeHostBridgeAbi;
  const openFunction = value.openHostAttemptBridge;
  const openSupervisorFunction = value.openHostSupervisorBridge;
  if (
    typeof abiFunction !== 'function'
    || typeof openFunction !== 'function'
    || typeof openSupervisorFunction !== 'function'
  ) throw invalid('exports');
  const abi = abiFunction() as unknown;
  assertAbi(abi, runtimePackage);
  return Object.freeze({
    nativeHostBridgeAbi: abiFunction.bind(value),
    openHostAttemptBridge: openFunction.bind(value),
    openHostSupervisorBridge: openSupervisorFunction.bind(value),
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

export function assertNativeHostSupervisorChannel(
  value: unknown,
): asserts value is NativeHostSupervisorChannel {
  if (
    !record(value)
    || !identifier(value.managementConnectionId)
    || value.managementMaximumFrameBytes !== MANAGEMENT_FRAME_MAX_BYTES
    || !processId(value.supervisorProcessId)
    || value.isClosed !== false
    || typeof value.readManagement !== 'function'
    || typeof value.writeManagement !== 'function'
    || typeof value.close !== 'function'
  ) throw invalid('supervisor owner');
}

export function assertNativeHostSupervisorCloseReceipt(
  value: unknown,
  expectedProcessId: number,
): asserts value is NativeHostSupervisorCloseReceipt {
  if (
    !record(value)
    || value.processId !== expectedProcessId
    || !Number.isInteger(value.exitCode)
    || Number(value.exitCode) < 0
    || Number(value.exitCode) > 0xffff_ffff
    || typeof value.forced !== 'boolean'
  ) throw invalid('supervisor close receipt');
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
