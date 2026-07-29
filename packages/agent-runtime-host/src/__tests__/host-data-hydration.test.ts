import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import { createAuthorityClockForTesting } from '../ipc/AttemptClock.js';
import {
  encodeAttemptFrame,
  validateAttemptFrame,
} from '../ipc/AttemptFrame.js';
import {
  createHostPendingDataAttemptChannel,
} from '../ipc/HostDataAttemptChannel.js';
import type {
  HostDataHydrationRequest,
} from '../ipc/HostDataHydration.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import { identity } from './attempt-channel-support.js';

const CONNECTION = 'data-connection';
const RUNTIME = 'runtime-instance';
const MAXIMUM = 64 * 1024;
const CHUNK_BYTES = 4n;
const TOKEN = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe('Host data bind and hydration pump', () => {
  it('binds once and streams exact disk-source chunks through commit', async () => {
    const transport = duplexPair();
    const limits = frameLimits();
    const pending = createHostPendingDataAttemptChannel({
      transport: transport.host,
      identity: identity(),
      runtimeInstanceId: RUNTIME,
      connectionId: CONNECTION,
      connectionSessionToken: TOKEN,
      protocolVersion: 65_537,
      effectiveLimits: limits,
      maxIpcFrames: 64,
      hardDeadlineAtUnixMs: 90_000n,
      clock: createAuthorityClockForTesting(() => 10n),
    });
    expect('hydrate' in pending).toBe(false);

    const snapshotBytes = Buffer.from('abcdefghij');
    const artifactBytes = Buffer.from('xyz');
    const returnedChunks: Uint8Array[] = [];
    let closeCause: unknown = Symbol('not-closed');
    const request = hydrationRequest(
      snapshotBytes,
      artifactBytes,
      returnedChunks,
      (cause) => { closeCause = cause; },
    );
    const runner = driveRunner(transport.runner, limits, {
      snapshotBytes,
      artifactBytes,
    });

    const bound = await pending.bind();
    const receipt = await bound.hydrate(request);
    const observed = await runner;

    expect(receipt).toMatchObject({
      transferId: 'transfer:test',
      itemCount: 2,
      totalPayloadBytes: 13n,
    });
    expect([...observed.snapshot]).toEqual([...snapshotBytes]);
    expect([...observed.artifact]).toEqual([...artifactBytes]);
    expect(closeCause).toBeUndefined();
    expect(returnedChunks.length).toBeGreaterThan(0);
    for (const chunk of returnedChunks) {
      expect([...chunk]).toEqual(new Array(chunk.byteLength).fill(0));
    }
  });

  it('fails closed when the runner grants a non-exact chunk credit', async () => {
    const transport = duplexPair();
    const limits = frameLimits();
    const pending = createHostPendingDataAttemptChannel({
      transport: transport.host,
      identity: identity(),
      runtimeInstanceId: RUNTIME,
      connectionId: CONNECTION,
      connectionSessionToken: TOKEN,
      protocolVersion: 65_537,
      effectiveLimits: limits,
      maxIpcFrames: 64,
      hardDeadlineAtUnixMs: 90_000n,
      clock: createAuthorityClockForTesting(() => 10n),
    });
    const peer = rejectWithWrongCredit(transport.runner, limits);
    const bound = await pending.bind();
    const request = hydrationRequest(
      Buffer.from('abcdefghij'),
      Buffer.from('xyz'),
      [],
      () => undefined,
    );

    await expect(bound.hydrate(request)).rejects.toMatchObject({
      code: 'invalid_hydration',
    });
    await peer;
    expect(bound.isFailed).toBe(true);
  });
});

function hydrationRequest(
  snapshotBytes: Uint8Array,
  artifactBytes: Uint8Array,
  returnedChunks: Uint8Array[],
  close: (cause?: unknown) => void,
): HostDataHydrationRequest {
  const bodies = [snapshotBytes, artifactBytes];
  return {
    transferId: 'transfer:test',
    maximumChunkBytes: CHUNK_BYTES,
    maxIpcBytes: 64n,
    maxIpcFrames: 64,
    maxArtifactBytes: 32n,
    maxSpoolBytes: 32n,
    source: {
      items: [
        {
          reference: {
            case: 'snapshot',
            value: create(agentV1Common.SnapshotRefSchema, {
              ref: 'snapshot:policy',
              version: 1n,
              contentSha256: sha256(snapshotBytes),
              origin: 'session-store',
              schemaId: 'test.snapshot',
              schemaVersion: 1,
            }),
          },
          byteLength: BigInt(snapshotBytes.byteLength),
        },
        {
          reference: {
            case: 'artifact',
            value: create(agentV1Artifact.ArtifactRefSchema, {
              artifactId: 'artifact:task',
              kind: 'task_input',
              contentSha256: sha256(artifactBytes),
              mediaType: 'application/octet-stream',
              byteLength: BigInt(artifactBytes.byteLength),
              compression: agentV1Artifact.ArtifactCompression.NONE,
              privacyClass:
                agentV1Artifact.ArtifactPrivacyClass.CONFIDENTIAL,
              redactionPolicyVersion: 'v1',
              ownerSessionId: identity().sessionId,
            }),
          },
          byteLength: BigInt(artifactBytes.byteLength),
        },
      ],
      async readExact(ordinal, offset, length) {
        const selected = bodies[ordinal]!;
        const chunk = Uint8Array.from(
          selected.subarray(Number(offset), Number(offset) + length),
        );
        returnedChunks.push(chunk);
        return chunk;
      },
      close,
    },
  };
}

async function driveRunner(
  peer: DelimitedByteChannel,
  limits: agentV1Common.FrameLimits,
  expected: {
    snapshotBytes: Uint8Array;
    artifactBytes: Uint8Array;
  },
): Promise<{ snapshot: Uint8Array; artifact: Uint8Array }> {
  let outboundSeq = 1n;
  const bind = await receiveData(peer);
  expect(bind.payload.body.case).toBe('bindAttemptChannel');
  if (bind.payload.body.case !== 'bindAttemptChannel') throw new Error('bind');
  expect(bind.payload.body.value.connectionSessionToken).toEqual(TOKEN);
  await sendResponse(peer, bind, outboundSeq++, {
    case: 'attemptChannelBound',
    value: create(agentV1Runtime.AttemptChannelBoundSchema, {
      identity: identity(),
      runtimeInstanceId: RUNTIME,
      channel: agentV1Runtime.TransportChannel.DATA,
      effectiveLimits: limits,
      boundAtUnixMs: 10n,
    }),
  });

  const manifest = await receiveData(peer);
  expect(manifest.payload.body.case).toBe('hydrationManifest');
  if (manifest.payload.body.case !== 'hydrationManifest') {
    throw new Error('manifest');
  }
  const digest = manifest.payloadDigest;
  const chunks: Uint8Array[] = [new Uint8Array(), new Uint8Array()];
  let ordinal = 0;
  let offset = 0n;
  let accepted = 0n;
  await sendProgress(
    peer,
    manifest,
    outboundSeq++,
    digest,
    ordinal,
    offset,
    accepted,
    CHUNK_BYTES,
  );

  while (ordinal < 2) {
    const inbound = await receiveData(peer);
    expect(inbound.payload.body.case).toBe('hydrationChunk');
    if (inbound.payload.body.case !== 'hydrationChunk') throw new Error('chunk');
    const chunk = inbound.payload.body.value;
    expect(chunk.itemOrdinal).toBe(ordinal);
    expect(chunk.offset).toBe(offset);
    expect([...chunk.manifestPayloadSha256]).toEqual([...digest]);
    chunks[ordinal] = concat(chunks[ordinal]!, chunk.encodedChunk);
    accepted += BigInt(chunk.encodedChunk.byteLength);
    offset += BigInt(chunk.encodedChunk.byteLength);
    if (chunk.endOfItem) {
      ordinal += 1;
      offset = 0n;
    }
    const remaining = ordinal === 0
      ? BigInt(expected.snapshotBytes.byteLength) - offset
      : ordinal === 1
        ? BigInt(expected.artifactBytes.byteLength) - offset
        : 0n;
    const credit = remaining < CHUNK_BYTES ? remaining : CHUNK_BYTES;
    await sendProgress(
      peer,
      inbound,
      outboundSeq++,
      digest,
      ordinal,
      offset,
      accepted,
      credit,
    );
  }
  const complete = await receiveData(peer);
  expect(complete.payload.body.case).toBe('hydrationComplete');
  await sendResponse(peer, complete, outboundSeq, {
    case: 'hydrationCommitted',
    value: create(agentV1Runtime.HydrationCommittedSchema, {
      identity: identity(),
      runtimeInstanceId: RUNTIME,
      transferId: 'transfer:test',
      manifestPayloadSha256: digest,
      itemCount: 2,
      totalPayloadBytes: 13n,
    }),
  });
  return { snapshot: chunks[0]!, artifact: chunks[1]! };
}

async function rejectWithWrongCredit(
  peer: DelimitedByteChannel,
  limits: agentV1Common.FrameLimits,
): Promise<void> {
  const bind = await receiveData(peer);
  await sendResponse(peer, bind, 1n, {
    case: 'attemptChannelBound',
    value: create(agentV1Runtime.AttemptChannelBoundSchema, {
      identity: identity(),
      runtimeInstanceId: RUNTIME,
      channel: agentV1Runtime.TransportChannel.DATA,
      effectiveLimits: limits,
      boundAtUnixMs: 10n,
    }),
  });
  const manifest = await receiveData(peer);
  await sendProgress(
    peer,
    manifest,
    2n,
    manifest.payloadDigest,
    0,
    0n,
    0n,
    3n,
  );
}

async function sendProgress(
  peer: DelimitedByteChannel,
  request: ReturnType<typeof validateAttemptFrame>,
  seq: bigint,
  digest: Uint8Array,
  ordinal: number,
  offset: bigint,
  accepted: bigint,
  credit: bigint,
): Promise<void> {
  await sendResponse(peer, request, seq, {
    case: 'hydrationProgress',
    value: create(agentV1Runtime.HydrationProgressSchema, {
      identity: identity(),
      runtimeInstanceId: RUNTIME,
      transferId: 'transfer:test',
      manifestPayloadSha256: digest,
      nextItemOrdinal: ordinal,
      nextOffset: offset,
      acceptedPayloadBytes: accepted,
      maxNextChunkBytes: credit,
    }),
  });
}

async function sendResponse(
  peer: DelimitedByteChannel,
  request: ReturnType<typeof validateAttemptFrame>,
  seq: bigint,
  body: agentV1Runtime.FramePayload['body'],
): Promise<void> {
  await peer.send(encodeAttemptFrame(
    responseHeader(
      `runner-data:${seq}`,
      seq,
      request.frame.header!.messageId,
    ),
    agentV1Runtime.TransportChannel.DATA,
    create(agentV1Runtime.FramePayloadSchema, { body }),
    MAXIMUM,
  ));
}

async function receiveData(peer: DelimitedByteChannel) {
  const bytes = await peer.receive();
  if (!bytes) throw new Error('unexpected data EOF');
  return validateAttemptFrame(
    bytes,
    agentV1Runtime.TransportChannel.DATA,
    MAXIMUM,
  );
}

function responseHeader(
  messageId: string,
  streamSeq: bigint,
  replyToMessageId: string,
) {
  const authority = identity();
  return create(agentV1Runtime.FrameHeaderSchema, {
    protocolVersion: 65_537,
    connectionId: CONNECTION,
    messageId,
    replyToMessageId,
    sessionId: authority.sessionId,
    commandId: authority.commandId,
    agentRunId: authority.agentRunId,
    attemptId: authority.attemptId,
    executorOwnerId: authority.executorOwnerId,
    fencingEpoch: authority.fencingEpoch,
    correlationId: authority.correlationId,
    rootAgentRunId: authority.rootAgentRunId,
    ownerAgentRunId: authority.ownerAgentRunId,
    streamSeq,
    sentAtUnixMs: 10n,
    deadlineAtUnixMs: 80_000n,
  });
}

function frameLimits() {
  return create(agentV1Common.FrameLimitsSchema, {
    maxFrameBytes: BigInt(MAXIMUM),
    maxChunkBytes: 32n,
    maxInFlightFrames: 1n,
    maxInFlightBytes: BigInt(MAXIMUM),
    readTimeoutMs: 30_000n,
    writeTimeoutMs: 30_000n,
  });
}

function duplexPair() {
  const hostToRunner = new PassThrough();
  const runnerToHost = new PassThrough();
  const options = {
    maximumFrameBytes: MAXIMUM,
    readTimeoutMs: 30_000,
    writeTimeoutMs: 30_000,
  };
  return {
    host: new DelimitedByteChannel(runnerToHost, hostToRunner, options),
    runner: new DelimitedByteChannel(hostToRunner, runnerToHost, options),
  };
}

function sha256(value: Uint8Array): Uint8Array {
  return createHash('sha256').update(value).digest();
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}
