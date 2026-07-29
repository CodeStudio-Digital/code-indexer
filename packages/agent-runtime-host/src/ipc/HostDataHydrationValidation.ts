import { createHash, timingSafeEqual, type Hash } from 'node:crypto';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { HostDataChannelError } from './HostDataChannelError.js';
import type {
  HostDataHydrationRequest,
  HostHydrationPlan,
} from './HostDataHydrationPlan.js';

export type HydrationProgressBody = Extract<
  agentV1Runtime.FramePayload['body'],
  { case: 'hydrationProgress' }
>;

export interface HydrationCursor {
  ordinal: number;
  offset: bigint;
  accepted: bigint;
  hash: Hash;
}

export function newHydrationCursor(): HydrationCursor {
  return {
    ordinal: 0,
    offset: 0n,
    accepted: 0n,
    hash: createHash('sha256'),
  };
}

export function requireHydrationProgress(
  body: agentV1Runtime.FramePayload['body'],
): HydrationProgressBody {
  if (body.case !== 'hydrationProgress') {
    throw unexpected(body.case, 'HydrationProgress');
  }
  return body;
}

export function assertHydrationProgress(
  value: agentV1Runtime.HydrationProgress,
  request: HostDataHydrationRequest,
  plan: HostHydrationPlan,
  digest: Uint8Array,
  cursor: HydrationCursor,
): void {
  const next = plan.items[cursor.ordinal];
  const expectedCredit = next
    ? minimum(request.maximumChunkBytes, next.byteLength - cursor.offset)
    : 0n;
  if (
    value.transferId !== request.transferId
    || !sameDigest(value.manifestPayloadSha256, digest)
    || value.nextItemOrdinal !== cursor.ordinal
    || value.nextOffset !== cursor.offset
    || value.acceptedPayloadBytes !== cursor.accepted
    || value.maxNextChunkBytes !== expectedCredit
  ) throw invalidHydration('runner hydration progress diverges from the exact cursor');
}

export function assertHydrationCommitted(
  value: agentV1Runtime.HydrationCommitted,
  request: HostDataHydrationRequest,
  plan: HostHydrationPlan,
  digest: Uint8Array,
): void {
  if (
    value.transferId !== request.transferId
    || !sameDigest(value.manifestPayloadSha256, digest)
    || value.itemCount !== plan.items.length
    || value.totalPayloadBytes !== plan.totalPayloadBytes
  ) throw invalidHydration('runner hydration commit diverges from the manifest');
}

export function sameDigest(
  actual: Uint8Array,
  expected: Uint8Array,
): boolean {
  return actual.byteLength === 32
    && expected.byteLength === 32
    && timingSafeEqual(actual, expected);
}

export function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function unexpected(
  actual: string | undefined,
  expected: string,
): HostDataChannelError {
  return invalidHydration(`expected ${expected}, received ${actual ?? 'missing'}`);
}

export function invalidHydration(message: string): HostDataChannelError {
  return new HostDataChannelError('invalid_hydration', message);
}