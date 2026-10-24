import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  HostSupervisorFactChannel,
} from '../ipc/HostSupervisorFactChannel.js';
import { HostSupervisorFactError } from './HostSupervisorFactError.js';
import type {
  HostCancelAttemptRequest,
  HostFenceAttemptRequest,
  HostReapAttemptRequest,
} from './HostLifecycleTypes.js';
import type {
  DurableSupervisorFactPort,
  HostSupervisorFactDriverOptions,
  HostSupervisorFactStep,
  SupervisorLifecycleFact,
} from './HostSupervisorFactTypes.js';
import {
  commitDurableSupervisorFact,
} from './DurableSupervisorFactCommit.js';
import {
  assertHostSupervisorFactIntegrationMode,
} from './HostSupervisorFactIntegrationGate.js';
import {
  takeHostSupervisorFactDriverBinding,
} from './HostSupervisorFactDriverConstruction.js';
import {
  aborted,
  cloneFact,
  correlationFailure,
  raceOperation,
  validTimeout,
} from './HostSupervisorFactDriverSupport.js';

type LaunchFactPhase =
  | 'outcome' | 'spawned' | 'containment' | 'running' | 'exited' | 'complete';

/**
 * Minimal established-channel first-launch slice. Authentic construction
 * arrives only from the same-stream bootstrap/launch owner; this driver owns
 * physical facts through their durable commit and exact ManagementAck.
 */
export class HostSupervisorFactDriver {
  get remainingIdentityCapacity(): number { return this.#channel.remainingInboundIdentities; }

  readonly #channel: HostSupervisorFactChannel;
  #phase: LaunchFactPhase = 'outcome';
  #reservationId?: string;
  #runtimeInstanceId?: string;
  #resourceGroupId?: string;
  readonly #durableCommitTimeoutMs: number;
  readonly #commandResponseTimeoutMs: number;
  readonly #nowUnixMs: () => bigint;
  #processing = false;

  constructor(
    transport: DelimitedByteChannel,
    private readonly durableFacts: DurableSupervisorFactPort,
    options: HostSupervisorFactDriverOptions,
  ) {
    assertHostSupervisorFactIntegrationMode(options.integrationMode);
    const binding = takeHostSupervisorFactDriverBinding(options, transport);
    if (!validTimeout(options.durableCommitTimeoutMs)) {
      const failure = new HostSupervisorFactError(
        'invalid_handoff',
        'durable commit timeout must be between 1 and 60000 ms',
      );
      transport.fail(failure, binding.owner);
      throw failure;
    }
    if (!validTimeout(options.commandResponseTimeoutMs)) {
      const failure = new HostSupervisorFactError(
        'invalid_handoff',
        'command response timeout must be between 1 and 60000 ms',
      );
      transport.fail(failure, binding.owner);
      throw failure;
    }
    this.#durableCommitTimeoutMs = options.durableCommitTimeoutMs;
    this.#commandResponseTimeoutMs = options.commandResponseTimeoutMs;
    this.#nowUnixMs = options.nowUnixMs;
    this.#channel = new HostSupervisorFactChannel(
      transport,
      binding.owner,
      binding.handoff,
      options.nowUnixMs,
    );
  }

  async processNext(signal?: AbortSignal): Promise<HostSupervisorFactStep> {
    if (this.#processing) {
      const failure = new HostSupervisorFactError(
        'pending_fact_active',
        'only one management fact may be processed at a time',
      );
      this.#channel.abort(failure);
      throw failure;
    }
    if (signal?.aborted) {
      const failure = aborted(signal.reason);
      this.#channel.abort(failure);
      throw failure;
    }
    this.#processing = true;
    try {
      const outcome = await raceOperation(
        this.#channel.beginReceive(),
        signal,
      );
      if (outcome.kind !== 'pending') return outcome;
      const pending = outcome.pending;
      const factCase = pending.fact.case;
      try {
        this.#assertExpected(pending.fact);
        await commitDurableSupervisorFact(
          this.durableFacts,
          cloneFact(pending.fact),
          {
            ...pending.binding,
            payloadSha256: pending.binding.payloadSha256.slice(),
            envelopeSha256: pending.binding.envelopeSha256.slice(),
          },
          this.#durableCommitTimeoutMs,
          this.#nowUnixMs,
          signal,
        );
        if (signal?.aborted) throw aborted(signal.reason);
      } catch (cause) {
        return this.#channel.reject(pending, cause);
      }
      await this.#channel.acknowledge(pending);
      this.#advance(pending.fact);
      return {
        kind: 'committed',
        factCase,
        messageId: pending.binding.messageId,
      };
    } catch (cause) {
      if (cause instanceof HostSupervisorFactError) {
        if (cause.code === 'aborted') this.#channel.abort(cause);
        throw cause;
      }
      const failure = aborted(cause);
      this.#channel.abort(failure);
      throw failure;
    } finally {
      this.#processing = false;
    }
  }

  abort(cause?: unknown): void {
    this.#channel.abort(cause);
  }

  renewAuthority(request: import('./HostLifecycleTypes.js').HostAuthorityRenewalRequest): Promise<void> {
    if (this.#phase !== 'running') return Promise.reject(new Error('Authority renewal requires a live physical attempt'));
    return this.#channel.renewAuthority(request, this.#commandResponseTimeoutMs);
  }

  cancel(request: HostCancelAttemptRequest): Promise<void> {
    return this.#channel.cancel(request, this.#commandResponseTimeoutMs);
  }

  fence(request: HostFenceAttemptRequest): Promise<void> {
    return this.#channel.fence(request, this.#commandResponseTimeoutMs);
  }

  reap(request: HostReapAttemptRequest): Promise<void> {
    return this.#channel.reap(request, this.#commandResponseTimeoutMs);
  }

  get isPoisoned(): boolean {
    return this.#channel.isPoisoned;
  }

  #assertExpected(fact: SupervisorLifecycleFact): void {
    const factCase = fact.case;
    const valid = (
      (this.#phase === 'outcome'
        && (factCase === 'launchAccepted' || factCase === 'launchRejected'))
      || (this.#phase === 'spawned' && factCase === 'attemptProcessSpawned')
      || (
        this.#phase === 'containment'
        && factCase === 'attemptContainmentReport'
      )
      || (this.#phase === 'running' && factCase === 'attemptProcessExited')
      || (this.#phase === 'exited' && factCase === 'attemptProcessReaped')
    );
    if (!valid) {
      throw new HostSupervisorFactError(
        'invalid_lifecycle_order',
        `fact ${factCase} is invalid during ${this.#phase}`,
      );
    }
    if (
      fact.case === 'attemptProcessSpawned'
      && fact.value.reservationId !== this.#reservationId
    ) {
      throw correlationFailure('spawned reservation does not match acceptance');
    }
    if (
      fact.case === 'attemptContainmentReport'
      && fact.value.runtimeInstanceId !== this.#runtimeInstanceId
    ) {
      throw correlationFailure('containment runtime does not match spawn');
    }
    if (
      fact.case === 'attemptProcessExited'
      && fact.value.runnerProvenance?.runtimeInstanceId !== this.#runtimeInstanceId
    ) throw correlationFailure('exit runtime does not match spawn');
    if (fact.case === 'attemptProcessReaped' && (
      fact.value.runtimeInstanceId !== this.#runtimeInstanceId
      || fact.value.resourceGroupId !== this.#resourceGroupId
    )) throw correlationFailure('reap ownership does not match spawn');
  }

  #advance(fact: SupervisorLifecycleFact): void {
    if (fact.case === 'launchAccepted') {
      this.#reservationId = fact.value.reservationId;
      this.#phase = 'spawned';
    } else if (fact.case === 'attemptProcessSpawned') {
      this.#runtimeInstanceId = fact.value.runnerProvenance!.runtimeInstanceId;
      this.#resourceGroupId = fact.value.resourceGroupId;
      this.#phase = 'containment';
    } else if (fact.case === 'attemptContainmentReport') this.#phase = 'running';
    else if (fact.case === 'attemptProcessExited') this.#phase = 'exited';
    else this.#phase = 'complete';
  }
}
