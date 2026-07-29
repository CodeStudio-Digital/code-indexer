import { createHash, timingSafeEqual } from 'node:crypto';
import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
} from '@mcp/agent-runtime-contracts';

const SHA256_BYTES = 32;
const MAX_UINT64 = (1n << 64n) - 1n;

export function validateActivationAuthoritySeal(
  value: agentV1Common.ActivationAuthoritySeal | undefined,
): asserts value is agentV1Common.ActivationAuthoritySeal {
  if (
    !value
    || value.agentRunVersion <= 0n
    || value.agentRunVersion > MAX_UINT64
    || value.attemptVersion <= 0n
    || value.attemptVersion > MAX_UINT64
    || value.activationNonceSha256.byteLength !== SHA256_BYTES
  ) throw new RangeError('activation authority seal');
}

export function snapshotActivationAuthoritySeal(
  value: agentV1Common.ActivationAuthoritySeal | undefined,
): agentV1Common.ActivationAuthoritySeal {
  validateActivationAuthoritySeal(value);
  return clone(agentV1Common.ActivationAuthoritySealSchema, value);
}

export function activationAuthoritySealMatches(
  seal: agentV1Common.ActivationAuthoritySeal,
  agentRunVersion: bigint,
  attemptVersion: bigint,
  activationNonce: Uint8Array,
): boolean {
  if (
    agentRunVersion !== seal.agentRunVersion
    || attemptVersion !== seal.attemptVersion
    || seal.activationNonceSha256.byteLength !== SHA256_BYTES
  ) return false;
  const actual = createHash('sha256').update(activationNonce).digest();
  try {
    return timingSafeEqual(seal.activationNonceSha256, actual);
  } finally {
    actual.fill(0);
  }
}

export function scrubActivationAuthoritySeal(
  value: agentV1Common.ActivationAuthoritySeal | undefined,
): void {
  value?.activationNonceSha256.fill(0);
  if (value) value.activationNonceSha256 = new Uint8Array();
}
