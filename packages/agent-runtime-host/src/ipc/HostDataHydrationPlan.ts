import { clone, create } from '@bufbuild/protobuf';
import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import { HostDataChannelError } from './HostDataChannelError.js';

export type HostHydrationReference =
  | {
    readonly case: 'snapshot';
    readonly value: agentV1Common.SnapshotRef;
  }
  | {
    readonly case: 'artifact';
    readonly value: agentV1Artifact.ArtifactRef;
  };

export interface HostHydrationItemDescriptor {
  readonly reference: HostHydrationReference;
  readonly byteLength: bigint;
}

/**
 * Disk/session-store seam. `readExact` transfers ownership of its returned
 * chunk to the pump, which zeroizes it after the frame exchange settles.
 */
export interface HostHydrationSource {
  readonly items: readonly HostHydrationItemDescriptor[];
  readExact(
    ordinal: number,
    offset: bigint,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  close(cause?: unknown): void | Promise<void>;
}

export interface HostDataHydrationRequest {
  readonly transferId: string;
  readonly maximumChunkBytes: bigint;
  readonly maxIpcBytes: bigint;
  readonly maxIpcFrames: number;
  readonly maxArtifactBytes: bigint;
  readonly maxSpoolBytes: bigint;
  readonly source: HostHydrationSource;
  readonly signal?: AbortSignal;
}

export interface PlannedHostHydrationItem {
  readonly ordinal: number;
  readonly byteLength: bigint;
  readonly contentSha256: Uint8Array;
}

export interface HostHydrationPlan {
  readonly manifest: agentV1Runtime.HydrationManifest;
  readonly items: readonly PlannedHostHydrationItem[];
  readonly totalPayloadBytes: bigint;
}

const MAX_TRANSFER_ID_BYTES = 512;
const MAX_UINT32 = 0xffff_ffff;
const claimedSources = new WeakSet<object>();

export function buildHostHydrationPlan(
  request: HostDataHydrationRequest,
  channelMaximumChunkBytes: bigint,
): HostHydrationPlan {
  validateRequest(request, channelMaximumChunkBytes);
  if (claimedSources.has(request.source)) {
    throw invalid('hydration source was already consumed');
  }
  claimedSources.add(request.source);
  let total = 0n;
  let artifactTotal = 0n;
  let chunkFrames = 0n;
  const keys = new Set<string>();
  const planned: PlannedHostHydrationItem[] = [];
  const manifestItems: agentV1Runtime.HydrationItem[] = [];
  for (let ordinal = 0; ordinal < request.source.items.length; ordinal += 1) {
    const descriptor = request.source.items[ordinal]!;
    const normalized = normalizeItem(descriptor, ordinal);
    if (keys.has(normalized.key)) throw invalid('hydration references must be unique');
    keys.add(normalized.key);
    total = checkedAdd(total, descriptor.byteLength);
    if (descriptor.reference.case === 'artifact') {
      artifactTotal = checkedAdd(artifactTotal, descriptor.byteLength);
      if (
        descriptor.byteLength > request.maxArtifactBytes
        || artifactTotal > request.maxSpoolBytes
      ) throw invalid('artifact hydration budget is exceeded');
    }
    chunkFrames = checkedAdd(
      chunkFrames,
      divideCeil(descriptor.byteLength, request.maximumChunkBytes),
    );
    planned.push(Object.freeze({
      ordinal,
      byteLength: descriptor.byteLength,
      contentSha256: normalized.contentSha256,
    }));
    manifestItems.push(create(agentV1Runtime.HydrationItemSchema, {
      ordinal,
      reference: normalized.reference,
      byteLength: descriptor.byteLength,
    }));
  }
  const transactionFrames = checkedAdd(chunkFrames, 3n) * 2n;
  if (
    total <= 0n
    || total > request.maxIpcBytes
    || transactionFrames > BigInt(request.maxIpcFrames)
  ) throw invalid('hydration transaction budget is exceeded');
  return Object.freeze({
    manifest: create(agentV1Runtime.HydrationManifestSchema, {
      transferId: request.transferId,
      items: manifestItems,
      totalPayloadBytes: total,
      maxChunkBytes: request.maximumChunkBytes,
    }),
    items: Object.freeze(planned),
    totalPayloadBytes: total,
  });
}

function validateRequest(
  request: HostDataHydrationRequest,
  channelMaximumChunkBytes: bigint,
): void {
  if (
    request.transferId.length === 0
    || Buffer.byteLength(request.transferId, 'utf8') > MAX_TRANSFER_ID_BYTES
    || /\s|[\x00-\x1f\x7f]/u.test(request.transferId)
    || request.maximumChunkBytes <= 0n
    || request.maximumChunkBytes > channelMaximumChunkBytes
    || request.maximumChunkBytes > request.maxIpcBytes
    || request.maxIpcBytes <= 0n
    || request.maxArtifactBytes <= 0n
    || request.maxSpoolBytes <= 0n
    || !Number.isInteger(request.maxIpcFrames)
    || request.maxIpcFrames < 6
    || request.maxIpcFrames > 65_536
    || request.source.items.length === 0
    || request.source.items.length > MAX_UINT32
    || typeof request.source.readExact !== 'function'
    || typeof request.source.close !== 'function'
  ) throw invalid('hydration request is invalid');
}

function normalizeItem(
  descriptor: HostHydrationItemDescriptor,
  ordinal: number,
): {
  key: string;
  contentSha256: Uint8Array;
  reference: agentV1Runtime.HydrationItem['reference'];
} {
  if (descriptor.byteLength <= 0n) throw invalid('hydration item is empty');
  if (descriptor.reference.case === 'snapshot') {
    const value = clone(
      agentV1Common.SnapshotRefSchema,
      descriptor.reference.value,
    );
    if (
      value.ref.length === 0
      || value.contentSha256.byteLength !== 32
    ) throw invalid('snapshot hydration metadata is invalid');
    return {
      key: `snapshot:${value.ref}`,
      contentSha256: value.contentSha256.slice(),
      reference: { case: 'snapshot', value },
    };
  }
  const value = clone(
    agentV1Artifact.ArtifactRefSchema,
    descriptor.reference.value,
  );
  if (
    value.artifactId.length === 0
    || value.contentSha256.byteLength !== 32
    || value.byteLength !== descriptor.byteLength
  ) throw invalid('artifact hydration metadata is invalid');
  return {
    key: `artifact:${value.artifactId}`,
    contentSha256: value.contentSha256.slice(),
    reference: { case: 'artifact', value },
  };
}

function checkedAdd(left: bigint, right: bigint): bigint {
  const result = left + right;
  if (result > ((1n << 64n) - 1n)) throw invalid('hydration budget overflows uint64');
  return result;
}

function divideCeil(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function invalid(message: string): HostDataChannelError {
  return new HostDataChannelError('invalid_hydration', message);
}