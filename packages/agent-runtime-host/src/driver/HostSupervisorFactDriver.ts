import { clone, create } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import type { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  HostSupervisorFactChannel,
} from '../ipc/HostSupervisorFactChannel.js';
import { HostSupervisorFactError } from './HostSupervisorFactError.js';
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

type LaunchFactPhase = 'outcome' | 'spawned' | 'containment' | 'complete';

/**
 * Minimal established-channel first-launch slice. Authentic construction
 * arrives only from the same-stream bootstrap/launch owner; this driver owns
 * physical facts through their durable commit and exact ManagementAck.
 */
export class HostSupervisorFactDriver {
  readonly #channel: HostSupervisorFactChannel;
  #phase: LaunchFactPhase = 'outcome';
  #reservationId?: string;
  #runtimeInstanceId?: string;
  readonly #durableCommitTimeoutMs: number;
  readonly #nowUnixMs: () => bigint;
  #processing = false;

  constructor(
    transport: DelimitedByteChannel,
    private readonly durableFacts: DurableSupervisorFactPort,
    options: HostSupervisorFactDriverOptions,
  ) {
    assertHostSupervisorFactIntegrationMode(options.integrationMode);
    const binding = takeHostSupervisorFactDriverBinding(options, transport);
    if (
      !Number.isInteger(options.durableCommitTimeoutMs)
      || options.durableCommitTimeoutMs <= 0
      || options.durableCommitTimeoutMs > 60_000
    ) {
      const failure = new HostSupervisorFactError(
        'invalid_handoff',
        'durable commit timeout must be between 1 and 60000 ms',
      );
      transport.fail(failure, binding.owner);
      throw failure;
    }
    this.#durableCommitTimeoutMs = options.durableCommitTimeoutMs;
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
      if (outcome.kind === 'replayed') return outcome;
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
  }

  #advance(fact: SupervisorLifecycleFact): void {
    if (fact.case === 'launchAccepted') {
      this.#reservationId = fact.value.reservationId;
      this.#phase = 'spawned';
    } else if (fact.case === 'attemptProcessSpawned') {
      this.#runtimeInstanceId = fact.value.runnerProvenance!.runtimeInstanceId;
      this.#phase = 'containment';
    }
    else this.#phase = 'complete';
  }
}

function cloneFact(
  fact: SupervisorLifecycleFact,
): SupervisorLifecycleFact {
  const payload = clone(
    agentV1Supervisor.ManagementPayloadSchema,
    create(agentV1Supervisor.ManagementPayloadSchema, { body: fact }),
  );
  return payload.body as SupervisorLifecycleFact;
}

function correlationFailure(message: string): HostSupervisorFactError {
  return new HostSupervisorFactError('invalid_fact', message);
}

async function raceOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal?.aborted) throw aborted(signal.reason);
  let listener: (() => void) | undefined;
  const barriers: Promise<never>[] = [];
  if (signal) {
    const activeSignal = signal;
    barriers.push(new Promise<never>((_resolve, reject) => {
      listener = () => reject(aborted(activeSignal.reason));
      activeSignal.addEventListener('abort', listener, { once: true });
    }));
  }
  try {
    return await Promise.race([operation, ...barriers]);
  } finally {
    if (listener && signal) signal.removeEventListener('abort', listener);
  }
}

function aborted(cause: unknown): HostSupervisorFactError {
  return new HostSupervisorFactError(
    'aborted',
    'management fact processing was aborted',
    cause === undefined ? undefined : { cause },
  );
}
