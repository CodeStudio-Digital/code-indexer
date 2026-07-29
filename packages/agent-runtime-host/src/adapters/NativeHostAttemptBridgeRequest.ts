import { timingSafeEqual } from 'node:crypto';
import {
  clone,
  create,
  toBinary,
} from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import type {
  DurableSupervisorLaunchSnapshot,
} from '../driver/RustHostAttemptCoordinatorTypes.js';
import {
  assertContainmentExpectation,
} from '../ipc/ContainmentProofValidation.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';

declare const NATIVE_BRIDGE_REQUEST_BRAND: unique symbol;

export interface NativeHostAttemptBridgeOpenRequestOwner {
  readonly [NATIVE_BRIDGE_REQUEST_BRAND]: true;
}

export interface NativeHostAttemptBridgeOpenRequestInput {
  readonly launch: agentV1Supervisor.LaunchAttemptProcess;
  readonly durable: DurableSupervisorLaunchSnapshot;
  readonly openDeadlineAtUnixMs: bigint;
  readonly requiredContainmentLevel: agentV1Common.ContainmentLevel;
}

class NativeBridgeRequestOwner
implements NativeHostAttemptBridgeOpenRequestOwner {
  declare readonly [NATIVE_BRIDGE_REQUEST_BRAND]: true;
}

const requests = new WeakMap<object, Uint8Array>();
const abandonedRequestScrubber = new FinalizationRegistry<Uint8Array>(
  (encoded) => encoded.fill(0),
);

/**
 * Produces the only wire shape accepted by the native Host bridge. The
 * encoded secret-bearing request is single-use and never exposed as a stable
 * JavaScript value.
 */
export function encodeNativeHostAttemptBridgeOpenRequest(
  input: NativeHostAttemptBridgeOpenRequestInput,
): NativeHostAttemptBridgeOpenRequestOwner {
  validateInput(input);
  const request = create(
    agentV1Supervisor.HostAttemptBridgeOpenRequestSchema,
    {
      launch: clone(
        agentV1Supervisor.LaunchAttemptProcessSchema,
        input.launch,
      ),
      accepted: clone(
        agentV1Supervisor.LaunchAcceptedSchema,
        input.durable.accepted,
      ),
      spawned: clone(
        agentV1Supervisor.AttemptProcessSpawnedSchema,
        input.durable.spawned,
      ),
      containment: clone(
        agentV1Supervisor.AttemptContainmentReportSchema,
        input.durable.containment,
      ),
      openDeadlineAtUnixMs: input.openDeadlineAtUnixMs,
      requiredContainmentLevel: input.requiredContainmentLevel,
    },
  );
  try {
    const encoded = toBinary(
      agentV1Supervisor.HostAttemptBridgeOpenRequestSchema,
      request,
    );
    const owner = Object.freeze(new NativeBridgeRequestOwner());
    requests.set(owner, encoded);
    abandonedRequestScrubber.register(owner, encoded, owner);
    return owner;
  } catch (cause) {
    throw invalid('native Host bridge request could not be encoded', cause);
  } finally {
    scrubRequest(request);
  }
}

/**
 * Transfers one request into the native call and scrubs the exact encoded
 * bytes after settlement, including throw/rejection.
 */
export async function useNativeHostAttemptBridgeOpenRequest<T>(
  owner: NativeHostAttemptBridgeOpenRequestOwner,
  invoke: (encoded: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const encoded = requests.get(owner);
  if (!encoded) {
    throw invalid('native Host bridge request was consumed or foreign');
  }
  requests.delete(owner);
  abandonedRequestScrubber.unregister(owner);
  try {
    return await invoke(encoded);
  } finally {
    encoded.fill(0);
  }
}

export function abortNativeHostAttemptBridgeOpenRequest(
  owner: NativeHostAttemptBridgeOpenRequestOwner,
): void {
  const encoded = requests.get(owner);
  if (!encoded) return;
  requests.delete(owner);
  abandonedRequestScrubber.unregister(owner);
  encoded.fill(0);
}

function validateInput(input: NativeHostAttemptBridgeOpenRequestInput): void {
  assertContainmentExpectation(
    input.requiredContainmentLevel,
    input.launch.requiredEnforcedLimits,
  );
  if (
    input.openDeadlineAtUnixMs <= 0n
    || input.openDeadlineAtUnixMs > input.launch.hardDeadlineAtUnixMs
    || input.openDeadlineAtUnixMs
      > input.launch.authorityLeaseExpiresAtUnixMs
    || !sameSeal(
      input.launch.activationAuthoritySeal,
      input.durable.activationAuthoritySeal,
    )
  ) throw invalid('native Host bridge authority is invalid');
}

function sameSeal(
  left: agentV1Common.ActivationAuthoritySeal | undefined,
  right: agentV1Common.ActivationAuthoritySeal,
): boolean {
  return !!left
    && left.agentRunVersion === right.agentRunVersion
    && left.attemptVersion === right.attemptVersion
    && left.activationNonceSha256.byteLength === 32
    && right.activationNonceSha256.byteLength === 32
    && timingSafeEqual(
      left.activationNonceSha256,
      right.activationNonceSha256,
    );
}

function scrubRequest(
  value: agentV1Supervisor.HostAttemptBridgeOpenRequest,
): void {
  const launch = value.launch;
  if (!launch) return;
  launch.launchNonce.fill(0);
  launch.activationAuthoritySeal?.activationNonceSha256.fill(0);
  for (const endpoint of launch.protectedEndpoints) {
    endpoint.connectionToken.fill(0);
  }
}

function invalid(message: string, cause?: unknown): AttemptControlAdapterError {
  return new AttemptControlAdapterError(
    'invalid_provision',
    message,
    cause === undefined ? undefined : { cause },
  );
}
