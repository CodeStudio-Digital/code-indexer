import { PassThrough } from 'node:stream';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import {
  encodeAttemptFrame,
  validateAttemptFrame,
} from '../ipc/AttemptFrame.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import { identity } from './attempt-channel-support.js';

export interface DataRunnerPeerOptions {
  readonly connectionId: string;
  readonly runtimeInstanceId: string;
  readonly connectionToken: Uint8Array;
  readonly limits: agentV1Common.FrameLimits;
  readonly hardDeadlineAtUnixMs: bigint;
  readonly transferId: string;
  readonly expectedBodies: readonly Uint8Array[];
}

export function dataDuplexPair(limits: agentV1Common.FrameLimits) {
  const hostToRunner = new PassThrough();
  const runnerToHost = new PassThrough();
  const options = {
    maximumFrameBytes: Number(limits.maxFrameBytes),
    maximumTransportChunkBytes: Number(limits.maxChunkBytes),
    readTimeoutMs: Number(limits.readTimeoutMs),
    writeTimeoutMs: Number(limits.writeTimeoutMs),
  };
  return {
    host: new DelimitedByteChannel(runnerToHost, hostToRunner, options),
    runner: new DelimitedByteChannel(hostToRunner, runnerToHost, options),
  };
}

export async function driveDataHydrationRunner(
  peer: DelimitedByteChannel,
  options: DataRunnerPeerOptions,
): Promise<readonly Uint8Array[]> {
  let outboundSeq = 1n;
  const bind = await receiveData(peer, options);
  if (bind.payload.body.case !== 'bindAttemptChannel') {
    throw new Error('expected BindAttemptChannel');
  }
  if (!sameBytes(
    bind.payload.body.value.connectionSessionToken,
    options.connectionToken,
  )) throw new Error('connection token diverged');
  await sendResponse(peer, bind, outboundSeq++, options, {
    case: 'attemptChannelBound',
    value: create(agentV1Runtime.AttemptChannelBoundSchema, {
      identity: identity(),
      runtimeInstanceId: options.runtimeInstanceId,
      channel: agentV1Runtime.TransportChannel.DATA,
      effectiveLimits: options.limits,
      boundAtUnixMs: 10n,
    }),
  });

  const manifest = await receiveData(peer, options);
  if (manifest.payload.body.case !== 'hydrationManifest') {
    throw new Error('expected HydrationManifest');
  }
  const digest = manifest.payloadDigest;
  const chunks: Uint8Array<ArrayBufferLike>[] = options.expectedBodies
    .map(() => new Uint8Array());
  let ordinal = 0;
  let offset = 0n;
  let accepted = 0n;
  await sendProgress(
    peer,
    manifest,
    outboundSeq++,
    options,
    digest,
    ordinal,
    offset,
    accepted,
    nextCredit(options, ordinal, offset),
  );

  while (ordinal < options.expectedBodies.length) {
    const inbound = await receiveData(peer, options);
    if (inbound.payload.body.case !== 'hydrationChunk') {
      throw new Error('expected HydrationChunk');
    }
    const chunk = inbound.payload.body.value;
    if (
      chunk.itemOrdinal !== ordinal
      || chunk.offset !== offset
      || !sameBytes(chunk.manifestPayloadSha256, digest)
    ) throw new Error('hydration cursor diverged');
    chunks[ordinal] = concat(chunks[ordinal]!, chunk.encodedChunk);
    accepted += BigInt(chunk.encodedChunk.byteLength);
    offset += BigInt(chunk.encodedChunk.byteLength);
    if (chunk.endOfItem) {
      if (!sameBytes(chunks[ordinal]!, options.expectedBodies[ordinal]!)) {
        throw new Error('hydrated body diverged');
      }
      ordinal += 1;
      offset = 0n;
    }
    await sendProgress(
      peer,
      inbound,
      outboundSeq++,
      options,
      digest,
      ordinal,
      offset,
      accepted,
      nextCredit(options, ordinal, offset),
    );
  }

  const complete = await receiveData(peer, options);
  if (complete.payload.body.case !== 'hydrationComplete') {
    throw new Error('expected HydrationComplete');
  }
  await sendResponse(peer, complete, outboundSeq, options, {
    case: 'hydrationCommitted',
    value: create(agentV1Runtime.HydrationCommittedSchema, {
      identity: identity(),
      runtimeInstanceId: options.runtimeInstanceId,
      transferId: options.transferId,
      manifestPayloadSha256: digest,
      itemCount: options.expectedBodies.length,
      totalPayloadBytes: accepted,
    }),
  });
  return chunks;
}

async function sendProgress(
  peer: DelimitedByteChannel,
  request: ReturnType<typeof validateAttemptFrame>,
  seq: bigint,
  options: DataRunnerPeerOptions,
  digest: Uint8Array,
  ordinal: number,
  offset: bigint,
  accepted: bigint,
  credit: bigint,
): Promise<void> {
  await sendResponse(peer, request, seq, options, {
    case: 'hydrationProgress',
    value: create(agentV1Runtime.HydrationProgressSchema, {
      identity: identity(),
      runtimeInstanceId: options.runtimeInstanceId,
      transferId: options.transferId,
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
  options: DataRunnerPeerOptions,
  body: agentV1Runtime.FramePayload['body'],
): Promise<void> {
  await peer.send(encodeAttemptFrame(
    responseHeader(
      `runner-data:${seq}`,
      seq,
      request.frame.header!.messageId,
      options,
    ),
    agentV1Runtime.TransportChannel.DATA,
    create(agentV1Runtime.FramePayloadSchema, { body }),
    Number(options.limits.maxFrameBytes),
  ));
}

async function receiveData(
  peer: DelimitedByteChannel,
  options: DataRunnerPeerOptions,
) {
  const bytes = await peer.receive();
  if (!bytes) throw new Error('unexpected data EOF');
  return validateAttemptFrame(
    bytes,
    agentV1Runtime.TransportChannel.DATA,
    Number(options.limits.maxFrameBytes),
  );
}

function responseHeader(
  messageId: string,
  streamSeq: bigint,
  replyToMessageId: string,
  options: DataRunnerPeerOptions,
) {
  const authority = identity();
  return create(agentV1Runtime.FrameHeaderSchema, {
    protocolVersion: 65_537,
    connectionId: options.connectionId,
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
    deadlineAtUnixMs: options.hardDeadlineAtUnixMs - 1n,
  });
}

function nextCredit(
  options: DataRunnerPeerOptions,
  ordinal: number,
  offset: bigint,
): bigint {
  const body = options.expectedBodies[ordinal];
  if (!body) return 0n;
  const remaining = BigInt(body.byteLength) - offset;
  return remaining < options.limits.maxChunkBytes
    ? remaining
    : options.limits.maxChunkBytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}
