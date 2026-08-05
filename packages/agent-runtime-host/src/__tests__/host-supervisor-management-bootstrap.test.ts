import { PassThrough, Readable } from 'node:stream';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { HostSupervisorFactDriver } from '../driver/HostSupervisorFactDriver.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  HostSupervisorManagementBootstrap,
} from '../ipc/HostSupervisorManagementBootstrap.js';
import {
  encodeManagementFrame,
  validateManagementFrame,
} from '../ipc/ManagementFrame.js';
import {
  acceptedFact,
  factFrame,
  MANAGEMENT_CONNECTION,
  MANAGEMENT_MAXIMUM,
  MANAGEMENT_PROTOCOL,
} from './host-supervisor-fact-support.js';
import {
  MANAGEMENT_TOKEN,
  SUPERVISOR_NONCE,
  bootstrapHarness,
  hostSupervisorHello,
  launchAttempt,
  launchOptions,
  supervisorHello,
  supervisorHelloFrame,
} from './host-supervisor-bootstrap-support.js';
import { captureWritable, delimit } from './attempt-channel-support.js';
import { activationAuthoritySeal } from './activation-authority-support.js';

function decode(encoded: Uint8Array) {
  return validateManagementFrame(encoded);
}

describe('HostSupervisorManagementBootstrap', () => {
  it('owns one stream through Hello, launch, durable fact, and ACK', async () => {
    const inbound = new PassThrough();
    inbound.write(delimit(supervisorHelloFrame()));
    const durable = { commit: vi.fn(async () => undefined) };
    const attempt = bootstrapHarness([], undefined, inbound);

    const capability = await attempt.bootstrap.establish();
    expect(attempt.capture.frames()).toHaveLength(1);
    const first = decode(attempt.capture.frames()[0]!);
    expect(first.frame.header?.streamSeq).toBe(1n);
    expect(first.payload.body.case).toBe('hostSupervisorHello');

    const driver = await capability.launch(
      launchAttempt(),
      durable,
      launchOptions(),
    );
    expect(attempt.capture.frames()).toHaveLength(2);
    const second = decode(attempt.capture.frames()[1]!);
    expect(second.frame.header?.streamSeq).toBe(2n);
    expect(second.payload.body.case).toBe('launchAttemptProcess');
    const accepted = factFrame(
      acceptedFact(),
      'accepted',
      2n,
      { replyToMessageId: second.frame.header!.messageId },
    );
    inbound.write(delimit(accepted));

    await expect(driver.processNext()).resolves.toMatchObject({
      kind: 'committed',
      factCase: 'launchAccepted',
    });
    expect(durable.commit).toHaveBeenCalledOnce();
    const third = decode(attempt.capture.frames()[2]!);
    expect(third.frame.header?.streamSeq).toBe(3n);
    expect(third.frame.header?.replyToMessageId).toBe('accepted');
    expect(third.payload.body.case).toBe('managementAck');

    await expect(capability.launch(
      launchAttempt(),
      durable,
      launchOptions(),
    )).rejects.toMatchObject({ code: 'launch_capability_consumed' });
    expect(attempt.capture.frames()).toHaveLength(3);
  });

  it('retains a coalesced post-Hello frame in the same physical reader', async () => {
    const hello = supervisorHelloFrame();
    const durable = { commit: vi.fn(async () => undefined) };
    const attempt = bootstrapHarness([
      hello,
      hello,
    ]);
    const capability = await attempt.bootstrap.establish();
    const driver = await capability.launch(
      launchAttempt(),
      durable,
      launchOptions(),
    );

    await expect(driver.processNext()).rejects.toMatchObject({
      code: 'message_id_retired',
    });
    expect(durable.commit).not.toHaveBeenCalled();
    expect(attempt.capture.frames()).toHaveLength(2);
  });

  it.each([
    {
      mutate: (hello: agentV1Supervisor.SupervisorHello) => {
        hello.contractSchemaVersion += 1;
      },
      code: 'contract_mismatch',
    },
    {
      mutate: (hello: agentV1Supervisor.SupervisorHello) => {
        hello.provenance!.buildId = 'foreign';
      },
      code: 'provenance_mismatch',
    },
    {
      mutate: (hello: agentV1Supervisor.SupervisorHello) => {
        hello.launchNonce = Uint8Array.from({ length: 32 }, () => 7);
      },
      code: 'nonce_mismatch',
    },
    {
      mutate: (hello: agentV1Supervisor.SupervisorHello) => {
        hello.supportedProtocols!.maximum = create(
          agentV1Common.ProtocolVersionSchema,
          { major: 1, minor: 0 },
        );
      },
      code: 'protocol_mismatch',
    },
  ])('poisons peer bootstrap mismatch: $code', async ({ mutate, code }) => {
    const hello = supervisorHello();
    mutate(hello);
    const attempt = bootstrapHarness([supervisorHelloFrame(hello)]);

    await expect(attempt.bootstrap.establish()).rejects.toMatchObject({ code });
    expect(attempt.transport.isFailed).toBe(true);
    expect(attempt.capture.frames()).toHaveLength(1);
  });

  it('binds feature and containment selections to SupervisorHello', async () => {
    const featurePolicy = hostSupervisorHello();
    featurePolicy.allowedFeatureBits = 0b10n;
    const feature = bootstrapHarness(
      [supervisorHelloFrame()],
      undefined,
      undefined,
      featurePolicy,
    );
    await expect(feature.bootstrap.establish()).rejects.toMatchObject({
      code: 'feature_mismatch',
    });

    const containmentPolicy = hostSupervisorHello();
    containmentPolicy.requiredContainmentLevel = 2;
    const containment = bootstrapHarness(
      [supervisorHelloFrame()],
      undefined,
      undefined,
      containmentPolicy,
    );
    await expect(containment.bootstrap.establish()).rejects.toMatchObject({
      code: 'containment_mismatch',
    });
  });

  it('rejects connection, protocol, direction, and sequence before handoff', async () => {
    const cases = [
      supervisorHelloFrame(supervisorHello(), { connectionId: 'foreign' }),
      supervisorHelloFrame(supervisorHello(), { protocolVersion: 65_538 }),
      supervisorHelloFrame(supervisorHello(), { streamSeq: 2n }),
      encodeWrongDirection(hostSupervisorHello()),
    ];
    for (const frame of cases) {
      const attempt = bootstrapHarness([frame]);
      await expect(attempt.bootstrap.establish()).rejects.toBeInstanceOf(Error);
      expect(attempt.transport.isFailed).toBe(true);
    }
  });

  it('binds declared chunk and timeout limits to the physical channel', () => {
    const capture = captureWritable();
    const transport = new DelimitedByteChannel(
      Readable.from([]),
      capture.writable,
      {
        maximumFrameBytes: MANAGEMENT_MAXIMUM,
        maximumTransportChunkBytes: 8 * 1024,
        readTimeoutMs: 10_000,
        writeTimeoutMs: 10_000,
      },
    );
    expect(() => new HostSupervisorManagementBootstrap(transport, {
      expectedConnectionId: 'management:test',
      expectedManagementSessionToken: MANAGEMENT_TOKEN,
      expectedSupervisorLaunchNonce: SUPERVISOR_NONCE,
      hostHello: hostSupervisorHello(),
      nowUnixMs: () => 1n,
    })).toThrow(expect.objectContaining({ code: 'physical_cap_mismatch' }));
    expect(transport.isFailed).toBe(true);
  });

  it('requires the exact bootstrap frame cap before any Hello bytes', () => {
    const capture = captureWritable();
    const transport = new DelimitedByteChannel(
      Readable.from([]),
      capture.writable,
      {
        maximumFrameBytes: MANAGEMENT_MAXIMUM - 1,
        maximumTransportChunkBytes: 16 * 1024,
        readTimeoutMs: 10_000,
        writeTimeoutMs: 10_000,
      },
    );
    expect(() => new HostSupervisorManagementBootstrap(transport, {
      expectedConnectionId: MANAGEMENT_CONNECTION,
      expectedManagementSessionToken: MANAGEMENT_TOKEN,
      expectedSupervisorLaunchNonce: SUPERVISOR_NONCE,
      hostHello: hostSupervisorHello(),
      nowUnixMs: () => 1n,
    })).toThrow(expect.objectContaining({ code: 'physical_cap_mismatch' }));
    expect(capture.frames()).toHaveLength(0);
  });

  it('validates the provisioned management token before first write', () => {
    const capture = captureWritable();
    const transport = new DelimitedByteChannel(
      Readable.from([]),
      capture.writable,
      {
        maximumFrameBytes: MANAGEMENT_MAXIMUM,
        maximumTransportChunkBytes: 16 * 1024,
        readTimeoutMs: 10_000,
        writeTimeoutMs: 10_000,
      },
    );
    expect(() => new HostSupervisorManagementBootstrap(transport, {
      expectedConnectionId: MANAGEMENT_CONNECTION,
      expectedManagementSessionToken:
        Uint8Array.from({ length: 32 }, () => 7),
      expectedSupervisorLaunchNonce: SUPERVISOR_NONCE,
      hostHello: hostSupervisorHello(),
      nowUnixMs: () => 1n,
    })).toThrow(expect.objectContaining({ code: 'invalid_provision' }));
    expect(capture.frames()).toHaveLength(0);
    expect(transport.isFailed).toBe(true);
  });

  it('poisons a malformed second frame after physically writing HostHello', async () => {
    const attempt = bootstrapHarness([Uint8Array.of(0xff)]);
    await expect(attempt.bootstrap.establish()).rejects.toMatchObject({
      code: 'invalid_frame',
    });
    expect(attempt.capture.frames()).toHaveLength(1);
    expect(attempt.transport.isFailed).toBe(true);
  });

  it('never mints authority after a Hello or launch write failure', async () => {
    const helloFailure = writableFailureBootstrap(1);
    await expect(helloFailure.bootstrap.establish()).rejects.toMatchObject({
      code: 'transport_failure',
    });
    expect(helloFailure.capture.frames()).toHaveLength(0);
    expect(helloFailure.transport.isFailed).toBe(true);

    const launchFailure = writableFailureBootstrap(4);
    const capability = await launchFailure.bootstrap.establish();
    const durable = { commit: vi.fn(async () => undefined) };
    await expect(capability.launch(
      launchAttempt(),
      durable,
      launchOptions(),
    )).rejects.toMatchObject({ code: 'transport_failure' });
    expect(decode(launchFailure.capture.frames()[0]!).payload.body.case)
      .toBe('hostSupervisorHello');
    expect(durable.commit).not.toHaveBeenCalled();
    expect(launchFailure.transport.isFailed).toBe(true);
  });

  it('idempotently aborts pending bootstrap and detached launch authority', async () => {
    const pendingInput = new PassThrough();
    const pending = bootstrapHarness([], undefined, pendingInput);
    const establishing = pending.bootstrap.establish();
    await waitForCapturedFrames(pending.capture, 1);
    expect(() => {
      pending.bootstrap.abort(new Error('cancel bootstrap'));
      pending.bootstrap.abort(new Error('duplicate cancel'));
    }).not.toThrow();
    await expect(establishing).rejects.toMatchObject({
      code: 'transport_failure',
    });
    expect(pending.transport.isFailed).toBe(true);

    const established = bootstrapHarness([supervisorHelloFrame()]);
    const capability = await established.bootstrap.establish();
    expect(() => {
      capability.abort(new Error('cancel launch'));
      capability.abort(new Error('duplicate cancel'));
    }).not.toThrow();
    await expect(capability.launch(
      launchAttempt(),
      { commit: vi.fn(async () => undefined) },
      launchOptions(),
    )).rejects.toMatchObject({ code: 'launch_capability_consumed' });
    expect(established.transport.isFailed).toBe(true);
  });

  it('rejects raw or replayed construction authority', async () => {
    const rawCapture = captureWritable();
    const rawTransport = new DelimitedByteChannel(
      Readable.from([]),
      rawCapture.writable,
      { maximumFrameBytes: MANAGEMENT_MAXIMUM },
    );
    expect(() => new HostSupervisorFactDriver(
      rawTransport,
      { commit: vi.fn(async () => undefined) },
      {
        handoff: {} as never,
        nowUnixMs: () => 1n,
        durableCommitTimeoutMs: 1_000,
        commandResponseTimeoutMs: 1_000,
        integrationMode: 'test',
      },
    )).toThrow(expect.objectContaining({ code: 'invalid_handoff' }));

    const attempt = bootstrapHarness([supervisorHelloFrame()]);
    const capability = await attempt.bootstrap.establish();
    const invalid = launchAttempt({
      launchNonce: new Uint8Array(1),
    });
    await expect(capability.launch(
      invalid,
      { commit: vi.fn(async () => undefined) },
      launchOptions(),
    )).rejects.toMatchObject({ code: 'invalid_launch' });
    expect(attempt.capture.frames()).toHaveLength(1);
    await expect(capability.launch(
      launchAttempt(),
      { commit: vi.fn(async () => undefined) },
      launchOptions(),
    )).rejects.toMatchObject({ code: 'launch_capability_consumed' });
  });

  it.each([
    ['missing', undefined],
    ['zero run version', activationAuthoritySeal({ agentRunVersion: 0n })],
    ['zero attempt version', activationAuthoritySeal({ attemptVersion: 0n })],
    ['wrong digest size', activationAuthoritySeal({
      activationNonceSha256: new Uint8Array(31),
    })],
  ])('rejects a %s activation authority seal before launch', async (
    _case,
    seal,
  ) => {
    const attempt = bootstrapHarness([supervisorHelloFrame()]);
    const capability = await attempt.bootstrap.establish();

    await expect(capability.launch(
      launchAttempt({ activationAuthoritySeal: seal }),
      { commit: vi.fn(async () => undefined) },
      launchOptions(),
    )).rejects.toMatchObject({ code: 'invalid_launch' });
    expect(attempt.capture.frames()).toHaveLength(1);
    expect(attempt.transport.isFailed).toBe(true);
  });
});

function encodeWrongDirection(
  hello: agentV1Supervisor.HostSupervisorHello,
): Uint8Array {
  return encodeManagementFrame(
    create(agentV1Supervisor.ManagementFrameHeaderSchema, {
      protocolVersion: MANAGEMENT_PROTOCOL,
      connectionId: MANAGEMENT_CONNECTION,
      messageId: 'wrong-direction',
      streamSeq: 1n,
      sentAtUnixMs: 1n,
    }),
    create(agentV1Supervisor.ManagementPayloadSchema, {
      body: { case: 'hostSupervisorHello', value: hello },
    }),
  );
}

function writableFailureBootstrap(failAtWrite: number) {
  const capture = captureWritable(failAtWrite);
  const transport = new DelimitedByteChannel(
    Readable.from([delimit(supervisorHelloFrame())]),
    capture.writable,
    {
      maximumFrameBytes: MANAGEMENT_MAXIMUM,
      maximumTransportChunkBytes: 16 * 1024,
      readTimeoutMs: 10_000,
      writeTimeoutMs: 10_000,
    },
  );
  return {
    capture,
    transport,
    bootstrap: new HostSupervisorManagementBootstrap(transport, {
      expectedConnectionId: MANAGEMENT_CONNECTION,
      expectedManagementSessionToken: MANAGEMENT_TOKEN,
      expectedSupervisorLaunchNonce: SUPERVISOR_NONCE,
      hostHello: hostSupervisorHello(),
      nowUnixMs: () => 1n,
    }),
  };
}

async function waitForCapturedFrames(
  capture: ReturnType<typeof captureWritable>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (capture.frames().length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${count} management frame(s)`);
}
