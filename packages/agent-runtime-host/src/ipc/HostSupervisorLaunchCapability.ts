import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import {
  bindHostSupervisorFactDriver,
} from '../driver/HostSupervisorFactDriverConstruction.js';
import { HostSupervisorFactDriver } from '../driver/HostSupervisorFactDriver.js';
import {
  assertHostSupervisorFactIntegrationMode,
} from '../driver/HostSupervisorFactIntegrationGate.js';
import type {
  DurableSupervisorFactPort,
  HostSupervisorFactDriverOptions,
} from '../driver/HostSupervisorFactTypes.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import { HostSupervisorBootstrapError } from './HostSupervisorBootstrapError.js';
import type {
  HostSupervisorLaunchOptions,
  HostSupervisorPolicySnapshot,
} from './HostSupervisorBootstrapTypes.js';
import {
  scrubLaunch,
  validateSupervisorLaunch,
} from './HostSupervisorLaunchValidation.js';
import { encodeManagementFrame } from './ManagementFrame.js';

export interface HostSupervisorLaunchCapability {
  launch(
    launch: agentV1Supervisor.LaunchAttemptProcess,
    durableFacts: DurableSupervisorFactPort,
    options: HostSupervisorLaunchOptions,
  ): Promise<HostSupervisorFactDriver>;
  abort(cause?: unknown): void;
}

export interface EstablishedHostSupervisorBootstrap {
  readonly transport: DelimitedByteChannel;
  readonly owner: object;
  readonly policy: HostSupervisorPolicySnapshot;
  readonly bootstrapInboundMessageId: string;
  readonly nowUnixMs: () => bigint;
}

export function createHostSupervisorLaunchCapability(
  established: EstablishedHostSupervisorBootstrap,
): HostSupervisorLaunchCapability {
  return new HostSupervisorLaunchCapabilityValue(established);
}

class HostSupervisorLaunchCapabilityValue
implements HostSupervisorLaunchCapability {
  #consumed = false;
  #established?: EstablishedHostSupervisorBootstrap;
  #active?: EstablishedHostSupervisorBootstrap;

  constructor(established: EstablishedHostSupervisorBootstrap) {
    this.#established = established;
  }

  async launch(
    candidate: agentV1Supervisor.LaunchAttemptProcess,
    durableFacts: DurableSupervisorFactPort,
    options: HostSupervisorLaunchOptions,
  ): Promise<HostSupervisorFactDriver> {
    const established = this.#established;
    if (this.#consumed || !established) {
      throw failure(
        'launch_capability_consumed',
        'management launch capability was already consumed',
      );
    }
    this.#consumed = true;
    this.#established = undefined;
    this.#active = established;
    let encoded: Uint8Array | undefined;
    let launch: agentV1Supervisor.LaunchAttemptProcess | undefined;
    try {
      validateDriverOptions(options);
      const sentAtUnixMs = established.nowUnixMs();
      const messageId = `management:host:${randomUUID()}:2`;
      const validated = validateSupervisorLaunch(
        candidate,
        established.policy,
        options,
        sentAtUnixMs,
        established.bootstrapInboundMessageId,
        messageId,
      );
      launch = validated.launch;
      encoded = encodeManagementFrame(
        create(agentV1Supervisor.ManagementFrameHeaderSchema, {
          protocolVersion: established.policy.protocolVersion,
          connectionId: established.policy.connectionId,
          messageId,
          streamSeq: 2n,
          sentAtUnixMs,
          deadlineAtUnixMs: validated.deadlineAtUnixMs,
        }),
        create(agentV1Supervisor.ManagementPayloadSchema, {
          body: { case: 'launchAttemptProcess', value: launch },
        }),
      );
      await established.transport.send(encoded, established.owner);
      return this.#handoff(
        established,
        validated.handoff,
        durableFacts,
        options,
      );
    } catch (cause) {
      const normalized = normalize(cause);
      try {
        established.transport.fail(normalized, established.owner);
      } catch {
        // Preserve the first established-channel failure.
      }
      throw normalized;
    } finally {
      this.#active = undefined;
      encoded?.fill(0);
      scrubLaunch(launch);
    }
  }

  abort(cause?: unknown): void {
    const established = this.#active ?? this.#established;
    this.#consumed = true;
    this.#established = undefined;
    this.#active = undefined;
    if (!established) return;
    try {
      established.transport.fail(normalize(cause), established.owner);
    } catch {
      // Preserve the first established-channel failure.
    }
  }

  #handoff(
    established: EstablishedHostSupervisorBootstrap,
    handoff: HostSupervisorFactDriverOptions['handoff'],
    durableFacts: DurableSupervisorFactPort,
    options: HostSupervisorLaunchOptions,
  ): HostSupervisorFactDriver {
    const driverOptions: HostSupervisorFactDriverOptions = {
      handoff,
      nowUnixMs: established.nowUnixMs,
      durableCommitTimeoutMs: options.durableCommitTimeoutMs,
      integrationMode: options.integrationMode,
    };
    bindHostSupervisorFactDriver(driverOptions, {
      transport: established.transport,
      owner: established.owner,
      handoff,
    });
    return new HostSupervisorFactDriver(
      established.transport,
      durableFacts,
      driverOptions,
    );
  }
}

function validateDriverOptions(options: HostSupervisorLaunchOptions): void {
  try {
    assertHostSupervisorFactIntegrationMode(options.integrationMode);
  } catch (cause) {
    throw new HostSupervisorBootstrapError(
      'invalid_launch',
      'management launch integration mode is invalid',
      { cause },
    );
  }
  if (
    !Number.isInteger(options.durableCommitTimeoutMs)
    || options.durableCommitTimeoutMs <= 0
    || options.durableCommitTimeoutMs > 60_000
  ) throw failure('invalid_launch', 'durable commit timeout is invalid');
}

function normalize(cause: unknown): HostSupervisorBootstrapError {
  return cause instanceof HostSupervisorBootstrapError
    ? cause
    : new HostSupervisorBootstrapError(
      'transport_failure',
      'management launch failed closed',
      { cause },
    );
}

function failure(
  code: HostSupervisorBootstrapError['code'],
  message: string,
): HostSupervisorBootstrapError {
  return new HostSupervisorBootstrapError(code, message);
}
