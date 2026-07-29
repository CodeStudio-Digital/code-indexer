import { fromBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  abortNativeHostAttemptBridgeOpenRequest,
  encodeNativeHostAttemptBridgeOpenRequest,
  useNativeHostAttemptBridgeOpenRequest,
} from '../adapters/NativeHostAttemptBridgeRequest.js';
import type {
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import {
  openNativeHostAttemptBridge,
  consumeNativeHostAttemptBridge,
  type NativeHostAttemptChannels,
  type NativeHostBridgeBinding,
} from '../native/index.js';
import { activationAuthoritySeal } from './activation-authority-support.js';
import {
  acceptedFact,
  containmentFact,
  spawnedFact,
} from './host-supervisor-fact-support.js';
import { launchAttempt } from './host-supervisor-bootstrap-support.js';

describe('NativeHostAttemptBridgeRequest', () => {
  it('encodes one generated request and scrubs it after native settlement', async () => {
    const fixture = requestFixture();
    const owner = encodeNativeHostAttemptBridgeOpenRequest(fixture);
    let retained: Uint8Array | undefined;
    const invoke = vi.fn((encoded: Uint8Array) => {
      retained = encoded;
      const request = fromBinary(
        agentV1Supervisor.HostAttemptBridgeOpenRequestSchema,
        encoded,
      );
      expect(request.launch).toEqual(fixture.launch);
      expect(request.accepted).toEqual(fixture.durable.accepted);
      expect(request.spawned).toEqual(fixture.durable.spawned);
      expect(request.containment).toEqual(fixture.durable.containment);
      expect(request.openDeadlineAtUnixMs).toBe(50_000n);
      return request.spawned!.runnerProvenance!.pid;
    });

    await expect(useNativeHostAttemptBridgeOpenRequest(
      owner,
      invoke,
    )).resolves.toBe(42);
    expect(invoke).toHaveBeenCalledOnce();
    expect(retained).toBeDefined();
    expect([...retained!]).toEqual(new Array(retained!.byteLength).fill(0));
    await expect(useNativeHostAttemptBridgeOpenRequest(
      owner,
      invoke,
    )).rejects.toMatchObject({ code: 'invalid_provision' });
  });

  it('scrubs encoded authority when the native call rejects', async () => {
    const owner = encodeNativeHostAttemptBridgeOpenRequest(requestFixture());
    let retained: Uint8Array | undefined;
    await expect(useNativeHostAttemptBridgeOpenRequest(owner, (encoded) => {
      retained = encoded;
      throw new Error('native failure');
    })).rejects.toThrow('native failure');
    expect(retained).toBeDefined();
    expect(retained!.every((value) => value === 0)).toBe(true);
  });

  it('rejects an activation seal that diverges from durable launch facts', () => {
    const fixture = requestFixture();
    fixture.durable.activationAuthoritySeal.attemptVersion += 1n;
    expect(() => encodeNativeHostAttemptBridgeOpenRequest(fixture))
      .toThrow(/authority is invalid/);
  });

  it('scrubs an owner aborted before native open and makes abort idempotent', async () => {
    const owner = encodeNativeHostAttemptBridgeOpenRequest(requestFixture());
    abortNativeHostAttemptBridgeOpenRequest(owner);
    abortNativeHostAttemptBridgeOpenRequest(owner);
    await expect(useNativeHostAttemptBridgeOpenRequest(
      owner,
      () => undefined,
    )).rejects.toMatchObject({ code: 'invalid_provision' });
  });

  it('transfers the opaque request directly into one validated native owner', async () => {
    const owner = encodeNativeHostAttemptBridgeOpenRequest(requestFixture());
    const channels = nativeChannels();
    let retained: Uint8Array | undefined;
    const binding = {
      nativeHostBridgeAbi: vi.fn(),
      openHostAttemptBridge: vi.fn(async (encoded: Uint8Array) => {
        retained = encoded;
        return channels;
      }),
    } as NativeHostBridgeBinding;

    const bridgeOwner = await openNativeHostAttemptBridge(binding, owner);
    expect(consumeNativeHostAttemptBridge(bridgeOwner)).toBe(channels);
    expect(binding.openHostAttemptBridge).toHaveBeenCalledOnce();
    expect(retained?.every((byte) => byte === 0)).toBe(true);
  });

  it('closes and rejects a native owner with divergent channel limits', async () => {
    const owner = encodeNativeHostAttemptBridgeOpenRequest(requestFixture());
    const close = vi.fn(async () => 'closed' as const);
    const binding = {
      nativeHostBridgeAbi: vi.fn(),
      openHostAttemptBridge: vi.fn(async () => ({
        ...nativeChannels(),
        close,
        controlMaximumFrameBytes: 1,
      })),
    } as unknown as NativeHostBridgeBinding;

    await expect(openNativeHostAttemptBridge(binding, owner))
      .rejects.toMatchObject({ code: 'invalid_provision' });
    expect(close).toHaveBeenCalledOnce();
  });
});

function nativeChannels(): NativeHostAttemptChannels {
  return {
    controlEndpointId: 'control:endpoint',
    controlConnectionId: 'control:connection',
    controlPeerPid: 42,
    controlMaximumFrameBytes: 256 * 1024,
    dataEndpointId: 'data:endpoint',
    dataConnectionId: 'data:connection',
    dataPeerPid: 42,
    dataMaximumFrameBytes: 1024 * 1024,
    isClosed: false,
    readControl: vi.fn(),
    readData: vi.fn(),
    writeControl: vi.fn(),
    writeData: vi.fn(),
    close: vi.fn(),
  };
}

function requestFixture(): {
  launch: agentV1Supervisor.LaunchAttemptProcess;
  durable: DurableSupervisorLaunchSnapshot;
  openDeadlineAtUnixMs: bigint;
  requiredContainmentLevel: agentV1Common.ContainmentLevel;
} {
  const launch = launchAttempt();
  for (const [index, endpoint] of launch.protectedEndpoints.entries()) {
    endpoint.connectionId = `connection:${index}`;
  }
  const accepted = acceptedFact().value as agentV1Supervisor.LaunchAccepted;
  const spawned = spawnedFact().value as agentV1Supervisor.AttemptProcessSpawned;
  const containment =
    containmentFact().value as agentV1Supervisor.AttemptContainmentReport;
  return {
    launch,
    durable: {
      accepted,
      spawned,
      containment,
      activationAuthoritySeal: activationAuthoritySeal(),
    },
    openDeadlineAtUnixMs: 50_000n,
    requiredContainmentLevel: agentV1Common.ContainmentLevel.HARD_PROCESS,
  };
}
