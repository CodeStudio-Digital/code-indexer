import { fromBinary } from '@bufbuild/protobuf';
import {
  agentV1SupervisorBootstrap,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  encodeNativeHostSupervisorBridgeOpenRequest,
  useNativeHostSupervisorBridgeOpenRequest,
} from '../adapters/NativeHostSupervisorBridgeRequest.js';
import type {
  HostSupervisorBootstrapProvision,
} from '../ipc/HostSupervisorBootstrapTypes.js';
import type {
  NativeHostBridgeBinding,
  NativeHostSupervisorChannel,
} from '../native/NativeHostBridgeBinding.js';
import {
  createNativeHostSupervisorManagementBootstrap,
} from '../native/NativeHostSupervisorManagement.js';
import type {
  VerifiedRuntimePackage,
} from '../packaging/RuntimePackageTypes.js';
import { BINARY_SHA256, delimit } from './attempt-channel-support.js';
import {
  MANAGEMENT_TOKEN,
  SUPERVISOR_NONCE,
  expectedProvenance,
  hostSupervisorHello,
  supervisorHello,
  supervisorHelloFrame,
} from './host-supervisor-bootstrap-support.js';
import {
  MANAGEMENT_CONNECTION,
  MANAGEMENT_MAXIMUM,
} from './host-supervisor-fact-support.js';

describe('native Host supervisor bridge', () => {
  it('binds package provenance and scrubs its single-use request', async () => {
    const owner = encodeNativeHostSupervisorBridgeOpenRequest({
      runtimePackage: runtimePackage(),
      provision: provision(),
    });
    let observed: Uint8Array | undefined;
    await useNativeHostSupervisorBridgeOpenRequest(owner, (encoded) => {
      observed = encoded;
      const request = fromBinary(
        agentV1SupervisorBootstrap.HostSupervisorBridgeOpenRequestSchema,
        encoded,
      );
      expect(request.managementConnectionId).toBe(MANAGEMENT_CONNECTION);
      expect(request.managementEndpointName).toMatch(/^management-[0-9a-f-]+$/u);
      expect(request.supervisorExecutable).toBe(
        'D:\\runtime\\agentd-supervisor.exe',
      );
      expect(request.runnerExecutable).toBe('D:\\runtime\\agent-runner.exe');
      expect(request.trustedSupervisorProvenance?.binarySha256)
        .toEqual(BINARY_SHA256);
      expect(request.managementSessionToken).toEqual(MANAGEMENT_TOKEN);
      expect(request.supervisorLaunchNonce).toEqual(SUPERVISOR_NONCE);
    });
    expect(observed).toBeDefined();
    expect(observed!.every((byte) => byte === 0)).toBe(true);
    await expect(useNativeHostSupervisorBridgeOpenRequest(
      owner,
      () => undefined,
    )).rejects.toThrow('consumed or foreign');
  });

  it('rejects a runtime artifact outside the Host policy', () => {
    const runtime = runtimePackage();
    const tampered: VerifiedRuntimePackage = {
      ...runtime,
      binaries: {
        ...runtime.binaries,
        supervisor: {
          ...runtime.binaries.supervisor,
          sha256: '00'.repeat(32),
        },
      },
    };
    expect(() => encodeNativeHostSupervisorBridgeOpenRequest({
      runtimePackage: tampered,
      provision: provision(),
    })).toThrow('outside Host policy');
  });

  it('carries the native stream through semantic Hello and owned close', async () => {
    const hello = supervisorHello();
    hello.provenance!.buildId = 'runtime-build';
    const inbound = [delimit(supervisorHelloFrame(hello))];
    const writes: Uint8Array[] = [];
    const close = vi.fn(async () => ({
      processId: 47,
      exitCode: 0,
      forced: false,
    }));
    const channel: NativeHostSupervisorChannel = {
      managementConnectionId: MANAGEMENT_CONNECTION,
      managementMaximumFrameBytes: MANAGEMENT_MAXIMUM,
      supervisorProcessId: 47,
      isClosed: false,
      readManagement: vi.fn(async () => inbound.shift() ?? null),
      writeManagement: vi.fn(async (bytes) => {
        writes.push(Uint8Array.from(bytes));
      }),
      close,
    };
    const binding: NativeHostBridgeBinding = {
      nativeHostBridgeAbi: vi.fn(),
      openHostAttemptBridge: vi.fn(),
      openHostSupervisorBridge: vi.fn(async () => channel),
    };

    const bootstrap = await createNativeHostSupervisorManagementBootstrap({
      binding,
      runtimePackage: runtimePackage(),
      provision: provision(),
    });
    expect(bootstrap.supervisorProcessId).toBe(47);
    const capability = await bootstrap.establish();
    expect(binding.openHostSupervisorBridge).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(2);
    expect(writes.every((bytes) => bytes.byteLength > 0)).toBe(true);

    capability.abort();
    await expect(bootstrap.close()).resolves.toEqual({
      processId: 47,
      exitCode: 0,
      forced: false,
    });
    expect(close).toHaveBeenCalledOnce();
    await expect(bootstrap.close()).resolves.toEqual({
      processId: 47,
      exitCode: 0,
      forced: false,
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

function provision(): HostSupervisorBootstrapProvision {
  const hostHello = hostSupervisorHello();
  hostHello.expectedSupervisorProvenance = expectedProvenance('runtime-build');
  hostHello.allowedRunnerProvenance = [expectedProvenance('runtime-build')];
  return {
    expectedConnectionId: MANAGEMENT_CONNECTION,
    expectedManagementSessionToken: MANAGEMENT_TOKEN,
    expectedSupervisorLaunchNonce: SUPERVISOR_NONCE,
    hostHello,
    nowUnixMs: () => 1n,
  };
}

function runtimePackage(): VerifiedRuntimePackage {
  const digest = Buffer.from(BINARY_SHA256).toString('hex');
  const binary = (
    role: 'hostBridge' | 'runner' | 'supervisor',
    file: string,
  ) => ({
    role,
    file,
    bytes: 1,
    sha256: digest,
    absolutePath: `D:\\runtime\\${file}`,
  });
  const hostBridge = binary('hostBridge', 'agent-host-bridge.node');
  const runner = binary('runner', 'agent-runner.exe');
  const supervisor = binary('supervisor', 'agentd-supervisor.exe');
  return {
    manifest: {
      schemaVersion: 1,
      packageVersion: 'test',
      buildId: 'runtime-build',
      sourceCommit: '0123456789abcdef',
      targetTriple: 'x86_64-pc-windows-msvc',
      operatingSystem: 'windows',
      architecture: 'x86_64',
      contractVersion: 'contract:test-v1',
      contractSchemaVersion: 1,
      binaries: [hostBridge, runner, supervisor],
    },
    manifestSha256: Uint8Array.from({ length: 32 }, () => 1),
    binaries: { hostBridge, runner, supervisor },
  };
}
