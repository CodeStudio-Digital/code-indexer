import { timingSafeEqual } from 'node:crypto';
import { clone } from '@bufbuild/protobuf';
import { detachedMessage } from '../ipc/DetachedMessage.js';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import {
  assertFrameIdentifier,
  attemptIdentityEqual,
} from '../ipc/FrameHeaderValidation.js';
import {
  activationAuthoritySealMatches,
} from '../ipc/ActivationAuthoritySealValidation.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import type {
  ActiveAttemptAuthorityFacts,
  DurableActivationGrant,
  PreparedDurabilityFacts,
} from './HostLifecycleTypes.js';

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_INT64 = (1n << 63n) - 1n;
const MIN_NONCE_BYTES = 16;
const MAX_NONCE_BYTES = 512;

export function validateDurableActivationGrant(
  value: DurableActivationGrant,
  facts: PreparedActivationAuthority,
  seal: agentV1Common.ActivationAuthoritySeal,
): agentV1Runtime.ActivateAttempt {
  let activate: agentV1Runtime.ActivateAttempt;
  try {
    activate = detachedMessage(agentV1Runtime.ActivateAttemptSchema, value.activate);
  } catch (cause) {
    throw invalidAuthority('durable activation payload is malformed', cause);
  }
  if (
    value.connectionId !== facts.connectionId
    || value.runtimeInstanceId !== facts.runtimeInstanceId
    || value.prepareMessageId !== facts.prepareMessageId
    || value.preparedMessageId !== facts.preparedMessageId
    || !activate.identity
    || !attemptIdentityEqual(activate.identity, facts.identity)
  ) {
    throw invalidAuthority(
      'durable activation grant belongs to another attempt authority',
    );
  }
  if (
    !sameDigest(activate.specSha256, facts.specSha256)
    || activate.agentRunVersion <= 0n
    || activate.agentRunVersion > MAX_UINT64
    || activate.attemptVersion <= 0n
    || activate.attemptVersion > MAX_UINT64
    || activate.deadlineAtUnixMs <= facts.readyAtUnixMs
    || activate.deadlineAtUnixMs > facts.maximumDeadlineAtUnixMs
    || activate.deadlineAtUnixMs > MAX_INT64
    || activate.activationNonce.byteLength < MIN_NONCE_BYTES
    || activate.activationNonce.byteLength > MAX_NONCE_BYTES
    || !activationAuthoritySealMatches(
      seal,
      activate.agentRunVersion,
      activate.attemptVersion,
      activate.activationNonce,
    )
  ) {
    throw invalidAuthority(
      'durable activation grant has invalid versions, deadline, nonce, or spec',
    );
  }
  try {
    assertFrameIdentifier(activate.idempotencyKey, 'activation idempotency key');
  } catch (cause) {
    throw invalidAuthority(
      'durable activation idempotency key is invalid',
      cause,
    );
  }
  return activate;
}

export interface PreparedActivationAuthority {
  readonly connectionId: string;
  readonly runtimeInstanceId: string;
  readonly prepareMessageId: string;
  readonly preparedMessageId: string;
  readonly identity: NonNullable<
    PreparedDurabilityFacts['prepared']['identity']
  >;
  readonly specSha256: Uint8Array;
  readonly readyAtUnixMs: bigint;
  readonly maximumDeadlineAtUnixMs: bigint;
}

export function snapshotPreparedActivationAuthority(
  facts: PreparedDurabilityFacts,
  maximumDeadlineAtUnixMs: bigint,
): PreparedActivationAuthority {
  if (!facts.prepared.identity) {
    throw invalidAuthority('prepared authority identity is missing');
  }
  return Object.freeze({
    connectionId: facts.connectionId,
    runtimeInstanceId: facts.prepared.runtimeInstanceId,
    prepareMessageId: facts.prepareMessageId,
    preparedMessageId: facts.preparedMessageId,
    identity: clone(
      agentV1Common.AttemptIdentitySchema,
      facts.prepared.identity,
    ),
    specSha256: Uint8Array.from(facts.prepared.specSha256),
    readyAtUnixMs: facts.prepared.readyAtUnixMs,
    maximumDeadlineAtUnixMs,
  });
}

export function activeAuthorityFacts(
  activate: agentV1Runtime.ActivateAttempt,
  prepared: PreparedActivationAuthority,
): ActiveAttemptAuthorityFacts {
  if (!activate.identity) {
    throw invalidAuthority('ActivateAttempt authority identity is missing');
  }
  return Object.freeze({
    identity: clone(
      agentV1Common.AttemptIdentitySchema,
      activate.identity,
    ),
    connectionId: prepared.connectionId,
    runtimeInstanceId: prepared.runtimeInstanceId,
    agentRunVersion: activate.agentRunVersion,
    attemptVersion: activate.attemptVersion,
    specSha256: Uint8Array.from(activate.specSha256),
    activationNonce: Uint8Array.from(activate.activationNonce),
    deadlineAtUnixMs: activate.deadlineAtUnixMs,
  });
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === 32
    && right.byteLength === 32
    && timingSafeEqual(left, right)
  );
}

function invalidAuthority(
  message: string,
  cause?: unknown,
): HostLifecycleDriverError {
  return new HostLifecycleDriverError(
    'invalid_durable_authority',
    message,
    cause === undefined ? undefined : { cause },
  );
}
