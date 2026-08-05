import { clone, create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Supervisor,
} from '@mcp/agent-runtime-contracts';
import {
  scrubActivationAuthoritySeal,
  snapshotActivationAuthoritySeal,
} from '../ipc/ActivationAuthoritySealValidation.js';
import { RustHostAttemptCoordinatorError } from './RustHostAttemptCoordinatorError.js';
import type {
  DurableSupervisorLaunchSnapshot,
} from './RustHostAttemptCoordinatorTypes.js';
import type {
  DurableSupervisorFactCommitControl,
  DurableSupervisorFactPort,
  SupervisorFactBinding,
  SupervisorLifecycleFact,
} from './HostSupervisorFactTypes.js';

type BarrierPhase = 'outcome' | 'spawned' | 'containment' | 'complete';

/**
 * Records bounded launch facts only after the real durable writer resolves.
 * The coordinator may release them only after processNext also sends the ACK.
 */
export class DurableSupervisorLaunchBarrier
implements DurableSupervisorFactPort {
  #phase: BarrierPhase = 'outcome';
  #accepted?: agentV1Supervisor.LaunchAccepted;
  #rejected?: agentV1Supervisor.LaunchRejected;
  #spawned?: agentV1Supervisor.AttemptProcessSpawned;
  #containment?: agentV1Supervisor.AttemptContainmentReport;
  #activationAuthoritySeal?: agentV1Common.ActivationAuthoritySeal;
  #released = false;
  #discarded = false;

  constructor(private readonly delegate: DurableSupervisorFactPort) {}

  async commit(
    fact: SupervisorLifecycleFact,
    binding: SupervisorFactBinding,
    control: DurableSupervisorFactCommitControl,
  ): Promise<void> {
    if (this.#discarded) throw barrierFailure('durable launch barrier is discarded');
    if (this.#released) {
      await this.delegate.commit(fact, binding, control);
      return;
    }
    const retained = cloneFact(fact);
    await this.delegate.commit(fact, binding, control);
    if (this.#discarded) return;
    this.#record(retained);
  }

  bindActivationAuthoritySeal(
    value: agentV1Common.ActivationAuthoritySeal | undefined,
  ): void {
    if (
      this.#discarded
      || this.#released
      || this.#phase !== 'outcome'
      || this.#activationAuthoritySeal
    ) throw barrierFailure('activation authority seal is already bound');
    this.#activationAuthoritySeal = snapshotActivationAuthoritySeal(value);
  }

  get outcome(): 'pending' | 'accepted' | 'rejected' {
    if (this.#rejected) return 'rejected';
    if (this.#accepted) return 'accepted';
    return 'pending';
  }

  releaseRejectedReasonCode(): string {
    if (this.#released || this.#phase !== 'complete' || !this.#rejected) {
      throw barrierFailure('durable launch rejection is unavailable');
    }
    this.#released = true;
    const reasonCode = this.#rejected.reasonCode;
    this.discard();
    return reasonCode;
  }

  releaseAccepted(): DurableSupervisorLaunchSnapshot {
    if (
      this.#released
      || this.#phase !== 'complete'
      || !this.#accepted
      || !this.#spawned
      || !this.#containment
      || !this.#activationAuthoritySeal
    ) throw barrierFailure('durable containment barrier is incomplete');
    this.#released = true;
    const snapshot = Object.freeze({
      accepted: this.#accepted,
      spawned: this.#spawned,
      containment: this.#containment,
      activationAuthoritySeal: this.#activationAuthoritySeal,
    });
    this.#accepted = undefined;
    this.#spawned = undefined;
    this.#containment = undefined;
    this.#activationAuthoritySeal = undefined;
    return snapshot;
  }

  discard(): void {
    if (this.#discarded) return;
    this.#discarded = true;
    this.#accepted = undefined;
    this.#rejected = undefined;
    this.#spawned = undefined;
    this.#containment = undefined;
    scrubActivationAuthoritySeal(this.#activationAuthoritySeal);
    this.#activationAuthoritySeal = undefined;
  }

  #record(fact: SupervisorLifecycleFact): void {
    if (this.#phase === 'outcome' && fact.case === 'launchAccepted') {
      this.#accepted = fact.value;
      this.#phase = 'spawned';
      return;
    }
    if (this.#phase === 'outcome' && fact.case === 'launchRejected') {
      this.#rejected = fact.value;
      this.#phase = 'complete';
      return;
    }
    if (this.#phase === 'spawned' && fact.case === 'attemptProcessSpawned') {
      this.#spawned = fact.value;
      this.#phase = 'containment';
      return;
    }
    if (
      this.#phase === 'containment'
      && fact.case === 'attemptContainmentReport'
    ) {
      this.#containment = fact.value;
      this.#phase = 'complete';
      return;
    }
    throw barrierFailure(`durable fact ${fact.case} crossed ${this.#phase}`);
  }
}

function cloneFact(
  fact: SupervisorLifecycleFact,
): SupervisorLifecycleFact {
  return clone(
    agentV1Supervisor.ManagementPayloadSchema,
    create(agentV1Supervisor.ManagementPayloadSchema, { body: fact }),
  ).body as SupervisorLifecycleFact;
}

function barrierFailure(message: string): RustHostAttemptCoordinatorError {
  return new RustHostAttemptCoordinatorError('management_barrier', message);
}
