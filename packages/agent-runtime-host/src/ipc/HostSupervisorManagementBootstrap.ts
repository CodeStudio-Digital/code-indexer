import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import {
  createHostSupervisorLaunchCapability,
  type HostSupervisorLaunchCapability,
} from './HostSupervisorLaunchCapability.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import { HostSupervisorBootstrapError } from './HostSupervisorBootstrapError.js';
import type {
  HostSupervisorBootstrapProvision,
  ValidatedHostSupervisorProvision,
} from './HostSupervisorBootstrapTypes.js';
import {
  validateHostSupervisorProvision,
} from './HostSupervisorProvisionValidation.js';
import {
  encodeManagementFrame,
  MANAGEMENT_FRAME_MAX_BYTES,
  ManagementFrameError,
  validateManagementFrame,
} from './ManagementFrame.js';
import { scrubManagementPayload } from './ManagementPayloadScrub.js';
import {
  validateSupervisorBootstrapFrame,
} from './SupervisorHelloValidation.js';

/**
 * Host-owned first-launch slice for the permanent management stream.
 * It writes Hello first, validates the peer Hello, and consumes itself into a
 * single-use launch capability over the exact same byte channel and owner.
 */
export class HostSupervisorManagementBootstrap {
  readonly #owner = {};
  #transport?: DelimitedByteChannel;
  #validated?: ValidatedHostSupervisorProvision;
  #nowUnixMs?: () => bigint;
  #started = false;
  #detached = false;

  constructor(
    transport: DelimitedByteChannel,
    provision: HostSupervisorBootstrapProvision,
  ) {
    if (transport.maximumFrameBytes !== MANAGEMENT_FRAME_MAX_BYTES) {
      const failure = new HostSupervisorBootstrapError(
        'physical_cap_mismatch',
        'management bootstrap requires the exact 64 KiB physical cap',
      );
      transport.fail(failure);
      throw failure;
    }
    let claimed = false;
    let validated: ValidatedHostSupervisorProvision | undefined;
    try {
      validated = validateHostSupervisorProvision(provision);
      transport.claim(this.#owner);
      claimed = true;
      assertPhysicalPolicy(transport, validated.policy.frameLimits);
    } catch (cause) {
      if (validated) {
        validated.hello.managementSessionToken.fill(0);
        validated.managementTokenDigest.fill(0);
        validated.supervisorNonceDigest.fill(0);
      }
      if (!transport.isFailed) {
        transport.fail(cause, claimed ? this.#owner : undefined);
      }
      throw cause;
    }
    this.#transport = transport;
    this.#validated = validated;
    this.#nowUnixMs = provision.nowUnixMs;
  }

  async establish(): Promise<HostSupervisorLaunchCapability> {
    if (this.#detached) {
      throw failure(
        'wrong_bootstrap_order',
        'management bootstrap was already consumed',
      );
    }
    if (this.#started) {
      throw this.#poison(failure(
        'wrong_bootstrap_order',
        'management bootstrap may run only once',
      ));
    }
    this.#started = true;
    const transport = this.#transport;
    const validatedProvision = this.#validated;
    const ownerClock = this.#nowUnixMs;
    if (!transport || !validatedProvision || !ownerClock) {
      throw failure(
        'wrong_bootstrap_order',
        'management bootstrap authority is unavailable',
      );
    }
    let inbound: Uint8Array | undefined;
    let validated: ReturnType<typeof validateManagementFrame> | undefined;
    try {
      await this.#sendHostHello(transport, validatedProvision, ownerClock);
      inbound = await transport.receive(this.#owner);
      if (!inbound) {
        throw failure('unexpected_eof', 'management stream ended before SupervisorHello');
      }
      const observedAtUnixMs = validatedClock(ownerClock);
      validated = validateManagementFrame(inbound);
      const bootstrapInboundMessageId = validateSupervisorBootstrapFrame(
        validated.frame.header!,
        validated.payload,
        validatedProvision.policy,
        validatedProvision.supervisorNonceDigest,
        observedAtUnixMs,
      );
      transport.narrowMaximumFrameBytes(
        Number(validatedProvision.policy.frameLimits.maxFrameBytes),
        this.#owner,
      );
      this.#detached = true;
      return createHostSupervisorLaunchCapability({
        transport,
        owner: this.#owner,
        policy: validatedProvision.policy,
        bootstrapInboundMessageId,
        nowUnixMs: () => validatedClock(ownerClock),
      });
    } catch (cause) {
      throw this.#poison(normalize(cause), transport);
    } finally {
      inbound?.fill(0);
      validated?.frame.header?.payloadSha256.fill(0);
      validated?.frame.encodedPayload.fill(0);
      scrubManagementPayload(validated?.payload);
      this.#releaseProvision(validatedProvision);
    }
  }

  abort(cause?: unknown): void {
    if (this.#detached) return;
    this.#poison(normalize(cause));
    this.#detached = true;
    if (!this.#started) this.#releaseProvision(this.#validated);
  }

  async #sendHostHello(
    transport: DelimitedByteChannel,
    validated: ValidatedHostSupervisorProvision,
    ownerClock: () => bigint,
  ): Promise<void> {
    const payload = create(agentV1Supervisor.ManagementPayloadSchema, {
      body: {
        case: 'hostSupervisorHello',
        value: validated.hello,
      },
    });
    let encoded: Uint8Array | undefined;
    try {
      encoded = encodeManagementFrame(
        create(agentV1Supervisor.ManagementFrameHeaderSchema, {
          protocolVersion: validated.policy.protocolVersion,
          connectionId: validated.policy.connectionId,
          messageId: `management-bootstrap:host:${randomUUID()}:1`,
          streamSeq: 1n,
          sentAtUnixMs: validatedClock(ownerClock),
        }),
        payload,
      );
      await transport.send(encoded, this.#owner);
    } finally {
      encoded?.fill(0);
      scrubManagementPayload(payload);
    }
  }

  #poison(
    cause: HostSupervisorBootstrapError,
    transport = this.#transport,
  ): HostSupervisorBootstrapError {
    try {
      transport?.fail(cause, this.#owner);
    } catch {
      // Preserve the first bootstrap failure.
    }
    return cause;
  }

  #releaseProvision(
    validated: ValidatedHostSupervisorProvision | undefined,
  ): void {
    validated?.managementTokenDigest.fill(0);
    validated?.supervisorNonceDigest.fill(0);
    validated?.hello.managementSessionToken.fill(0);
    this.#transport = undefined;
    this.#validated = undefined;
    this.#nowUnixMs = undefined;
  }
}

function normalize(cause: unknown): HostSupervisorBootstrapError {
  if (cause instanceof HostSupervisorBootstrapError) return cause;
  if (cause instanceof ManagementFrameError) {
    return new HostSupervisorBootstrapError(
      'invalid_frame',
      'management bootstrap frame is invalid',
      { cause },
    );
  }
  return new HostSupervisorBootstrapError(
    'transport_failure',
    'management bootstrap failed closed',
    { cause },
  );
}

function failure(
  code: HostSupervisorBootstrapError['code'],
  message: string,
): HostSupervisorBootstrapError {
  return new HostSupervisorBootstrapError(code, message);
}

function assertPhysicalPolicy(
  transport: DelimitedByteChannel,
  limits: import('@mcp/agent-runtime-contracts')
    .agentV1Common.FrameLimits,
): void {
  if (
    BigInt(transport.maximumTransportChunkBytes) !== limits.maxChunkBytes
    || BigInt(transport.readTimeoutMs) !== limits.readTimeoutMs
    || BigInt(transport.writeTimeoutMs) !== limits.writeTimeoutMs
  ) {
    throw failure(
      'physical_cap_mismatch',
      'management frame limits do not match the physical channel',
    );
  }
}

function validatedClock(clock: () => bigint): bigint {
  const now = clock();
  if (now <= 0n || now > (1n << 63n) - 1n) {
    throw failure('invalid_header', 'management owner clock is invalid');
  }
  return now;
}
