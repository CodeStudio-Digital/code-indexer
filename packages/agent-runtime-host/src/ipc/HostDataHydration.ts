import { createHash } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { framePayloadSha256 } from './AttemptFrame.js';
import type { HostBoundDataAttemptChannel } from './HostDataAttemptChannel.js';
import { HostDataChannelError } from './HostDataChannelError.js';
import {
  type HydrationCursor,
  type HydrationProgressBody,
  assertHydrationCommitted,
  assertHydrationProgress,
  invalidHydration,
  minimum,
  newHydrationCursor,
  requireHydrationProgress,
  sameDigest,
  unexpected,
} from './HostDataHydrationValidation.js';
import {
  type HostDataHydrationRequest,
  type HostHydrationPlan,
  buildHostHydrationPlan,
} from './HostDataHydrationPlan.js';

export type {
  HostDataHydrationRequest,
  HostHydrationItemDescriptor,
  HostHydrationReference,
  HostHydrationSource,
} from './HostDataHydrationPlan.js';

export interface HostDataHydrationReceipt {
  readonly transferId: string;
  readonly manifestPayloadSha256: Uint8Array;
  readonly itemCount: number;
  readonly totalPayloadBytes: bigint;
}

export async function sendHostDataHydration(
  channel: HostBoundDataAttemptChannel,
  request: HostDataHydrationRequest,
): Promise<HostDataHydrationReceipt> {
  let failure: unknown;
  try {
    const plan = buildHostHydrationPlan(
      request,
      channel.context.limits.maxChunkBytes,
    );
    const manifestPayload = create(agentV1Runtime.FramePayloadSchema, {
      body: {
        case: 'hydrationManifest',
        value: {
          ...plan.manifest,
          identity: channel.context.identity,
        },
      },
    });
    const manifestDigest = framePayloadSha256(toBinary(
      agentV1Runtime.FramePayloadSchema,
      manifestPayload,
    ));
    let progress = requireHydrationProgress(await channel.exchange(manifestPayload));
    const cursor = newHydrationCursor();
    assertHydrationProgress(progress.value, request, plan, manifestDigest, cursor);
    while (cursor.ordinal < plan.items.length) {
      progress = await sendNextChunk(
        channel,
        request,
        plan,
        manifestDigest,
        cursor,
        progress.value.maxNextChunkBytes,
      );
    }
    const complete = create(agentV1Runtime.FramePayloadSchema, {
      body: {
        case: 'hydrationComplete',
        value: {
          identity: channel.context.identity,
          transferId: request.transferId,
          manifestPayloadSha256: manifestDigest,
          itemCount: plan.items.length,
          totalPayloadBytes: plan.totalPayloadBytes,
        },
      },
    });
    const committed = await channel.exchange(complete);
    if (committed.case !== 'hydrationCommitted') {
      throw unexpected(committed.case, 'HydrationCommitted');
    }
    assertHydrationCommitted(committed.value, request, plan, manifestDigest);
    return Object.freeze({
      transferId: request.transferId,
      manifestPayloadSha256: manifestDigest.slice(),
      itemCount: plan.items.length,
      totalPayloadBytes: plan.totalPayloadBytes,
    });
  } catch (cause) {
    failure = cause;
    channel.abort(cause);
    throw cause;
  } finally {
    try {
      await request.source.close(failure);
    } catch (cause) {
      if (failure === undefined) {
        channel.abort(cause);
        throw new HostDataChannelError(
          'source_failure',
          'hydration source close failed',
          { cause },
        );
      }
    }
  }
}

async function sendNextChunk(
  channel: HostBoundDataAttemptChannel,
  request: HostDataHydrationRequest,
  plan: HostHydrationPlan,
  manifestDigest: Uint8Array,
  cursor: HydrationCursor,
  grantedBytes: bigint,
): Promise<HydrationProgressBody> {
  request.signal?.throwIfAborted();
  const item = plan.items[cursor.ordinal]!;
  const remaining = item.byteLength - cursor.offset;
  const expectedBytes = minimum(request.maximumChunkBytes, remaining);
  if (
    grantedBytes !== expectedBytes
    || grantedBytes <= 0n
    || grantedBytes > BigInt(Number.MAX_SAFE_INTEGER)
  ) throw invalidHydration('runner granted an invalid hydration credit');
  let chunk: Uint8Array;
  try {
    chunk = await request.source.readExact(
      cursor.ordinal,
      cursor.offset,
      Number(grantedBytes),
      request.signal,
    );
  } catch (cause) {
    throw new HostDataChannelError(
      'source_failure',
      'hydration source read failed',
      { cause },
    );
  }
  if (chunk.byteLength !== Number(grantedBytes)) {
    chunk.fill(0);
    throw new HostDataChannelError(
      'source_failure',
      'hydration source returned a short or oversized chunk',
    );
  }
  const endOfItem = cursor.offset + grantedBytes === item.byteLength;
  const chunkDigest = createHash('sha256').update(chunk).digest();
  cursor.hash.update(chunk);
  if (endOfItem && !sameDigest(cursor.hash.digest(), item.contentSha256)) {
    chunk.fill(0);
    throw new HostDataChannelError(
      'source_failure',
      'hydration source content digest diverges from its committed reference',
    );
  }
  const payload = create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: 'hydrationChunk',
      value: {
        identity: channel.context.identity,
        transferId: request.transferId,
        manifestPayloadSha256: manifestDigest,
        itemOrdinal: cursor.ordinal,
        offset: cursor.offset,
        encodedChunk: chunk,
        chunkSha256: chunkDigest,
        endOfItem,
      },
    },
  });
  try {
    const response = requireHydrationProgress(await channel.exchange(payload));
    cursor.accepted += grantedBytes;
    cursor.offset += grantedBytes;
    if (endOfItem) {
      cursor.ordinal += 1;
      cursor.offset = 0n;
      cursor.hash = createHash('sha256');
    }
    assertHydrationProgress(response.value, request, plan, manifestDigest, cursor);
    return response;
  } finally {
    chunk.fill(0);
    if (payload.body.case === 'hydrationChunk') {
      payload.body.value.encodedChunk.fill(0);
      payload.body.value.chunkSha256.fill(0);
    }
  }
}
