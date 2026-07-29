import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { HostSupervisorBootstrapError } from './HostSupervisorBootstrapError.js';

const TOKEN_DOMAIN = Buffer.from(
  'codestudio.agent.management-token.v1\0',
  'utf8',
);
const NONCE_DOMAIN = Buffer.from(
  'codestudio.agent.supervisor-nonce.v1\0',
  'utf8',
);
const MIN_SECRET_BYTES = 16;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_NONCE_BYTES = 256;

export function sealManagementToken(secret: Uint8Array): Uint8Array {
  return seal(secret, TOKEN_DOMAIN, MAX_TOKEN_BYTES, 'management token');
}

export function sealSupervisorNonce(secret: Uint8Array): Uint8Array {
  return seal(secret, NONCE_DOMAIN, MAX_NONCE_BYTES, 'supervisor nonce');
}

export function matchesManagementToken(
  digest: Uint8Array,
  candidate: Uint8Array,
): boolean {
  return matches(digest, candidate, TOKEN_DOMAIN, MAX_TOKEN_BYTES);
}

export function matchesSupervisorNonce(
  digest: Uint8Array,
  candidate: Uint8Array,
): boolean {
  return matches(digest, candidate, NONCE_DOMAIN, MAX_NONCE_BYTES);
}

function seal(
  secret: Uint8Array,
  domain: Uint8Array,
  maximum: number,
  label: string,
): Uint8Array {
  if (!validLength(secret.byteLength, maximum)) {
    throw new HostSupervisorBootstrapError(
      'invalid_provision',
      `${label} length is invalid`,
    );
  }
  return digest(domain, secret);
}

function matches(
  expected: Uint8Array,
  candidate: Uint8Array,
  domain: Uint8Array,
  maximum: number,
): boolean {
  if (expected.byteLength !== 32 || !validLength(candidate.byteLength, maximum)) {
    return false;
  }
  const actual = digest(domain, candidate);
  try {
    return timingSafeEqual(expected, actual);
  } finally {
    actual.fill(0);
  }
}

function digest(domain: Uint8Array, secret: Uint8Array): Uint8Array {
  return createHash('sha256').update(domain).update(secret).digest();
}

function validLength(length: number, maximum: number): boolean {
  return length >= MIN_SECRET_BYTES && length <= maximum;
}
