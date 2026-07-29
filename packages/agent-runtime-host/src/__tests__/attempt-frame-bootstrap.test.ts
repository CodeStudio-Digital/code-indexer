import { Readable } from 'node:stream';
import { create, fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTION,
  CONNECTION_TOKEN,
  MAXIMUM,
  RUNTIME,
  agentHello,
  agentHelloFrame,
  captureWritable,
  decodeFrame,
  delimit,
  heartbeatFrame,
  hostBootstrap,
  hostHello,
} from './attempt-channel-support.js';

describe('host bootstrap physical owner', () => {
  it('accepts AgentHello before writing a connection-bound HostHello', async () => {
    const { bootstrap, capture } = hostBootstrap([agentHelloFrame()]);

    const accepted = await bootstrap.receiveAgentHello();
    expect(accepted.provenance?.runtimeInstanceId).toBe(RUNTIME);
    expect(accepted).not.toHaveProperty('launchNonce');
    expect(capture!.frames()).toHaveLength(0);

    await bootstrap.establish(hostHello());
    const [encoded] = capture!.frames();
    const frame = decodeFrame(encoded!);
    const payload = fromBinary(
      agentV1Runtime.FramePayloadSchema,
      frame.encodedPayload,
    );
    expect(frame.header).toMatchObject({
      connectionId: CONNECTION,
      streamSeq: 1n,
      sentAtUnixMs: 10n,
    });
    expect(payload.body.case).toBe('hostHello');
    if (payload.body.case === 'hostHello') {
      expect(payload.body.value.connectionId).toBe(CONNECTION);
    }
  });

  it('poisons attempts to send HostHello before AgentHello', async () => {
    const { bootstrap, capture } = hostBootstrap([agentHelloFrame()]);

    await expect(bootstrap.establish(hostHello())).rejects.toMatchObject({
      code: 'bootstrap_order',
    });
    expect(capture!.frames()).toHaveLength(0);
    expect(bootstrap.isPoisoned).toBe(true);
  });

  it('rejects connection mismatches in AgentHello and HostHello', async () => {
    const inboundMismatch = hostBootstrap([
      agentHelloFrame(agentHello(), { connectionId: 'other-connection' }),
    ]);
    await expect(
      inboundMismatch.bootstrap.receiveAgentHello(),
    ).rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(inboundMismatch.capture!.frames()).toHaveLength(0);

    const outboundMismatch = hostBootstrap([agentHelloFrame()]);
    await outboundMismatch.bootstrap.receiveAgentHello();
    await expect(
      outboundMismatch.bootstrap.establish(
        hostHello({ connectionId: 'other-connection' }),
      ),
    ).rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(outboundMismatch.capture!.frames()).toHaveLength(0);
  });

  it('binds HostHello to the sealed session token and physical limits', async () => {
    const tokenMismatch = hostBootstrap([agentHelloFrame()]);
    await tokenMismatch.bootstrap.receiveAgentHello();
    await expect(
      tokenMismatch.bootstrap.establish(hostHello({
        connectionSessionToken: new Uint8Array(32),
      })),
    ).rejects.toMatchObject({ code: 'connection_token_mismatch' });

    const limitMismatch = hostBootstrap([agentHelloFrame()]);
    await limitMismatch.bootstrap.receiveAgentHello();
    await expect(
      limitMismatch.bootstrap.establish(hostHello({
        frameLimits: {
          maxFrameBytes: BigInt(MAXIMUM),
          maxChunkBytes: BigInt(Math.min(MAXIMUM, 64 * 1024)),
          maxInFlightFrames: 1n,
          maxInFlightBytes: BigInt(MAXIMUM),
          readTimeoutMs: 1n,
          writeTimeoutMs: 30_000n,
        },
        connectionSessionToken: CONNECTION_TOKEN,
      })),
    ).rejects.toMatchObject({ code: 'transport_limits_mismatch' });
  });

  it.each([
    { maxInFlightFrames: 2n },
    { maxInFlightBytes: BigInt(MAXIMUM - 1) },
    { transportCrc32c: true },
  ])('rejects unsupported V1 window/checksum facts %#', async (limits) => {
    const setup = hostBootstrap([agentHelloFrame()]);
    await setup.bootstrap.receiveAgentHello();
    const hello = hostHello();
    Object.assign(hello.frameLimits!, limits);

    await expect(
      setup.bootstrap.establish(hello),
    ).rejects.toMatchObject({ code: 'unsupported_frame_limits' });
    expect(setup.bootstrap.isPoisoned).toBe(true);
  });

  it.each([
    [{ heartbeatIntervalMs: 2_000n }, 'heartbeat_policy_mismatch'],
    [{ heartbeatTimeoutMs: 6_000n }, 'heartbeat_policy_mismatch'],
    [{ allowedFeatureBits: 0b01n }, 'feature_policy_mismatch'],
    [{ requiredFeatureBits: 0b10n }, 'feature_policy_mismatch'],
  ])('rejects unsealed HostHello negotiation facts %#', async (facts, code) => {
    const setup = hostBootstrap([agentHelloFrame()]);
    await setup.bootstrap.receiveAgentHello();

    await expect(
      setup.bootstrap.establish(hostHello(facts)),
    ).rejects.toMatchObject({ code });
    expect(setup.bootstrap.isPoisoned).toBe(true);
  });

  it('binds the AgentHello header protocol to its advertised maximum', async () => {
    const hello = agentHello({
      supportedProtocols: {
        minimum: { major: 1, minor: 1 },
        maximum: { major: 1, minor: 2 },
      },
    });
    const { bootstrap, capture } = hostBootstrap([
      agentHelloFrame(hello),
    ]);

    await expect(bootstrap.receiveAgentHello()).rejects.toMatchObject({
      code: 'protocol_mismatch',
    });
    expect(capture!.frames()).toHaveLength(0);
  });

  it.each([
    [
      agentHello({ launchNonce: Uint8Array.of(9) }),
      'launch_nonce_mismatch',
    ],
    [
      agentHello({ provenance: { runtimeInstanceId: 'other-runtime' } }),
      'runtime_instance_mismatch',
    ],
    [
      agentHello({
        provenance: {
          ...agentHello().provenance,
          runtimeInstanceId: RUNTIME,
          buildId: 'other-build',
        },
      }),
      'invalid_expected_provenance',
    ],
    [
      agentHello({ contractSchemaVersion: 2 }),
      'contract_mismatch',
    ],
    [
      agentHello({ supportedFeatureBits: 0n }),
      'required_feature_missing',
    ],
    [
      agentHello({
        supportedProtocols: {
          minimum: { major: 2, minor: 0 },
          maximum: { major: 2, minor: 0 },
        },
      }),
      'protocol_mismatch',
    ],
  ])('validates immutable launch binding %#', async (hello, code) => {
    const { bootstrap, capture } = hostBootstrap([agentHelloFrame(hello)]);
    await expect(bootstrap.receiveAgentHello()).rejects.toMatchObject({ code });
    expect(capture!.frames()).toHaveLength(0);
  });

  it('runs the sealed provenance/containment validator before HostHello', async () => {
    const validator = vi.fn(() => {
      throw new Error('containment rejected');
    });
    const { bootstrap, capture } = hostBootstrap([agentHelloFrame()], {
      validateAgentHello: validator,
    });

    await expect(bootstrap.receiveAgentHello()).rejects.toMatchObject({
      code: 'agent_hello_rejected',
    });
    expect(validator).toHaveBeenCalledOnce();
    expect(capture!.frames()).toHaveLength(0);
  });

  it('does not hand off when the physical HostHello write fails', async () => {
    const capture = captureWritable(1);
    const { bootstrap } = hostBootstrap([agentHelloFrame()], {
      writable: capture.writable,
    });
    await bootstrap.receiveAgentHello();

    await expect(bootstrap.establish(hostHello())).rejects.toMatchObject({
      code: 'transport_error',
    });
    expect(bootstrap.isPoisoned).toBe(true);
    expect(capture.frames()).toHaveLength(0);
  });

  it('samples the shared clock after the physical AgentHello read completes', async () => {
    let observedAt = 1n;
    let complete = false;
    const frame = agentHelloFrame(
      agentHello(),
      { deadlineAtUnixMs: 10n },
    );
    const source = (async function* () {
      const bytes = delimit(frame);
      yield bytes.subarray(0, bytes.byteLength - 1);
      await Promise.resolve();
      observedAt = 10n;
      complete = true;
      yield bytes.subarray(bytes.byteLength - 1);
    })();
    const { bootstrap } = hostBootstrap([], {
      readable: Readable.from(source),
      clock: () => observedAt,
    });

    await expect(bootstrap.receiveAgentHello()).rejects.toMatchObject({
      code: 'deadline_expired',
    });
    expect(complete).toBe(true);
  });

  it('makes the bootstrap alias inert after same-stream handoff', async () => {
    const { bootstrap } = hostBootstrap([
      agentHelloFrame(),
      heartbeatFrame('heartbeat-2', 2n),
    ]);
    await bootstrap.receiveAgentHello();
    const established = await bootstrap.establish(hostHello());

    await expect(bootstrap.establish(hostHello())).rejects.toMatchObject({
      code: 'bootstrap_consumed',
    });
    expect(established.isPoisoned).toBe(false);
    expect((await established.beginReceive())?.kind).toBe('pending');
  });
});
