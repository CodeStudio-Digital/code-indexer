import { timingSafeEqual } from 'node:crypto';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';
import {
  earliestLocalPeerTimestamp,
  latestLocalPeerTimestamp,
} from './LocalPeerClock.js';

export type DataOutboundRequestFacts =
  | {
    readonly requestCase: 'bindAttemptChannel';
    readonly runtimeInstanceId: string;
  }
  | {
    readonly requestCase: 'hydrationManifest';
    readonly transferId: string;
    readonly maxChunkBytes: bigint;
    readonly totalPayloadBytes: bigint;
  }
  | {
    readonly requestCase: 'hydrationChunk';
    readonly transferId: string;
    readonly manifestPayloadSha256: Uint8Array;
    readonly itemOrdinal: number;
    readonly nextOffset: bigint;
    readonly endOfItem: boolean;
  }
  | {
    readonly requestCase: 'hydrationComplete';
    readonly transferId: string;
    readonly manifestPayloadSha256: Uint8Array;
    readonly itemCount: number;
    readonly totalPayloadBytes: bigint;
  };

interface CorrelatedRequest {
  readonly facts: { readonly requestCase: string };
  readonly payloadDigest: Uint8Array;
  readonly sentAtUnixMs: bigint;
}

export function captureDataOutboundRequestFacts(
  payload: agentV1Runtime.FramePayload,
): DataOutboundRequestFacts | undefined {
  const body = payload.body;
  switch (body.case) {
    case 'bindAttemptChannel':
      return Object.freeze({
        requestCase: body.case,
        runtimeInstanceId: body.value.runtimeInstanceId,
      });
    case 'hydrationManifest':
      return Object.freeze({
        requestCase: body.case,
        transferId: body.value.transferId,
        maxChunkBytes: body.value.maxChunkBytes,
        totalPayloadBytes: body.value.totalPayloadBytes,
      });
    case 'hydrationChunk':
      return Object.freeze({
        requestCase: body.case,
        transferId: body.value.transferId,
        manifestPayloadSha256:
          body.value.manifestPayloadSha256.slice(),
        itemOrdinal: body.value.itemOrdinal,
        nextOffset: body.value.offset
          + BigInt(body.value.encodedChunk.byteLength),
        endOfItem: body.value.endOfItem,
      });
    case 'hydrationComplete':
      return Object.freeze({
        requestCase: body.case,
        transferId: body.value.transferId,
        manifestPayloadSha256:
          body.value.manifestPayloadSha256.slice(),
        itemCount: body.value.itemCount,
        totalPayloadBytes: body.value.totalPayloadBytes,
      });
    default:
      return;
  }
}

export function assertDataInboundCorrelation(
  payload: agentV1Runtime.FramePayload,
  observedAtUnixMs: bigint,
  request: CorrelatedRequest | undefined,
): boolean {
  const body = payload.body;
  if (body.case === 'attemptChannelBound') {
    const facts = request?.facts as DataOutboundRequestFacts | undefined;
    if (
      facts?.requestCase !== 'bindAttemptChannel'
      || body.value.runtimeInstanceId !== facts.runtimeInstanceId
      || body.value.channel !== agentV1Runtime.TransportChannel.DATA
      || body.value.boundAtUnixMs < earliestLocalPeerTimestamp(
        request?.sentAtUnixMs ?? 0n,
      )
      || body.value.boundAtUnixMs > latestLocalPeerTimestamp(observedAtUnixMs)
    ) throw mismatch('AttemptChannelBound contradicts its bind request');
    return true;
  }
  if (body.case === 'hydrationProgress') {
    assertProgress(
      body.value,
      request as HydrationRequest | undefined,
    );
    return true;
  }
  if (body.case === 'hydrationCommitted') {
    const facts = request?.facts as DataOutboundRequestFacts | undefined;
    if (
      facts?.requestCase !== 'hydrationComplete'
      || body.value.transferId !== facts.transferId
      || !sameDigest(
        body.value.manifestPayloadSha256,
        facts.manifestPayloadSha256,
      )
      || body.value.itemCount !== facts.itemCount
      || body.value.totalPayloadBytes !== facts.totalPayloadBytes
    ) throw mismatch('HydrationCommitted contradicts its completion request');
    return true;
  }
  return false;
}

export function isDataRunnerResponse(
  payloadCase: agentV1Runtime.FramePayload['body']['case'],
): boolean {
  return payloadCase === 'attemptChannelBound'
    || payloadCase === 'hydrationProgress'
    || payloadCase === 'hydrationCommitted';
}

type HydrationRequest = CorrelatedRequest & {
  readonly facts: Extract<
    DataOutboundRequestFacts,
    { requestCase: 'hydrationManifest' | 'hydrationChunk' }
  >;
};

function assertProgress(
  value: agentV1Runtime.HydrationProgress,
  request: HydrationRequest | undefined,
): void {
  const facts = request?.facts;
  if (facts?.requestCase === 'hydrationManifest') {
    if (
      value.transferId !== facts.transferId
      || !sameDigest(value.manifestPayloadSha256, request?.payloadDigest)
      || value.nextItemOrdinal !== 0
      || value.nextOffset !== 0n
      || value.acceptedPayloadBytes !== 0n
      || value.maxNextChunkBytes <= 0n
      || value.maxNextChunkBytes > facts.maxChunkBytes
      || value.maxNextChunkBytes > facts.totalPayloadBytes
    ) throw mismatch('HydrationProgress contradicts its manifest request');
    return;
  }
  if (facts?.requestCase === 'hydrationChunk') {
    const exactCursor = facts.endOfItem
      ? value.nextItemOrdinal === facts.itemOrdinal + 1
        && value.nextOffset === 0n
      : value.nextItemOrdinal === facts.itemOrdinal
        && value.nextOffset === facts.nextOffset;
    if (
      value.transferId !== facts.transferId
      || !sameDigest(
        value.manifestPayloadSha256,
        facts.manifestPayloadSha256,
      )
      || !exactCursor
    ) throw mismatch('HydrationProgress contradicts its chunk request');
    return;
  }
  throw mismatch('HydrationProgress has no compatible request');
}

function sameDigest(
  actual: Uint8Array,
  expected: Uint8Array | undefined,
): boolean {
  return expected !== undefined
    && actual.byteLength === 32
    && expected.byteLength === 32
    && timingSafeEqual(actual, expected);
}

function mismatch(message: string): AttemptFrameReceiverError {
  return new AttemptFrameReceiverError('correlation_mismatch', message);
}
