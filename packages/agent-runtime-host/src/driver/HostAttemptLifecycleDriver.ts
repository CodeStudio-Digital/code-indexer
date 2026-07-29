import { clone } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { type AuthorityClock } from '../ipc/AttemptClock.js';
import type { AcceptedAgentHello } from '../ipc/AgentHelloSummary.js';
import { type EstablishedAttemptChannel } from '../ipc/EstablishedAttemptChannel.js';
import { scrubActivationAuthoritySeal } from '../ipc/ActivationAuthoritySealValidation.js';
import {
  HostBootstrapAttemptChannel,
  createHostBootstrapAttemptChannelWithClock,
} from '../ipc/HostBootstrapAttemptChannel.js';
import { HostAuthorityLifetime } from './HostAuthorityLifetime.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import { takeLifecycleDriverClock } from './HostLifecycleDriverConstruction.js';
import { canonicalLifecycleFailure } from './HostLifecycleFailure.js';
import { HostLifecycleDriverPhase } from './HostLifecycleDriverState.js';
import {
  type ActiveAttemptAuthorityHandle,
  type ActiveAttemptReceipt,
  type PreparedAttemptReceipt,
} from './HostLifecycleReceipts.js';
import { HostLifecycleReceiptOwner } from './HostLifecycleReceiptOwner.js';
import { receiveCommittedActivationAck } from './HostLifecycleReceive.js';
import { sendActivateAttempt } from './HostLifecycleSend.js';
import type {
  HostAttemptLifecycleDriverOptions,
  ActiveAttemptAuthoritySnapshot,
  PreparedFactsExpectation,
  PreparedDurabilityPort,
} from './HostLifecycleTypes.js';
import {
  activeAuthorityFacts,
  snapshotPreparedActivationAuthority,
  validateDurableActivationGrant,
} from './HostLifecycleValidation.js';
import { consumeHostLifecycleLaunchBinding } from './HostLifecycleLaunchAuthority.js';
import { scrubPreparedDurabilityFacts } from './PreparedFactsScrub.js';
import { executeHostLifecyclePrepare } from './HostLifecyclePrepare.js';

export class HostAttemptLifecycleDriver {
  readonly #receipts = new HostLifecycleReceiptOwner();
  readonly #hostHello: agentV1Runtime.HostHello;
  readonly #outboundTimeoutMs: number;
  #durability?: PreparedDurabilityPort;
  #preparedExpectation?: PreparedFactsExpectation;
  #clock?: AuthorityClock;
  #authorityLifetime?: HostAuthorityLifetime;
  #activationAuthoritySeal?: agentV1Common.ActivationAuthoritySeal;
  #maximumActivationDeadlineAtUnixMs: bigint;
  #bootstrap?: HostBootstrapAttemptChannel;
  #channel?: EstablishedAttemptChannel;
  readonly #phase = new HostLifecycleDriverPhase();

  constructor(options: HostAttemptLifecycleDriverOptions) {
    const launch = consumeHostLifecycleLaunchBinding(options.launch);
    this.#hostHello = clone(
      agentV1Runtime.HostHelloSchema,
      options.hostHello,
    );
    this.#durability = options.durability;
    this.#preparedExpectation = launch.preparedExpectation;
    this.#activationAuthoritySeal = launch.activationAuthoritySeal;
    this.#maximumActivationDeadlineAtUnixMs =
      launch.maximumActivationDeadlineAtUnixMs;
    this.#outboundTimeoutMs = options.outboundTimeoutMs;
    const clock = takeLifecycleDriverClock(options);
    this.#clock = clock;
    this.#bootstrap = createHostBootstrapAttemptChannelWithClock(
      { launch: launch.bootstrapLaunch },
      clock,
      (cause) => this.#fail(cause),
    );
  }

  async handshake(): Promise<AcceptedAgentHello> {
    try {
      this.#phase.transition('awaiting_handshake', 'handshaking');
      const accepted = await this.#bootstrap!.receiveAgentHello();
      this.#channel = await this.#bootstrap!.establish(this.#hostHello);
      this.#bootstrap = undefined;
      this.#phase.set('established');
      return accepted;
    } catch (cause) {
      this.#raise(cause);
    }
  }

  async prepare(
    value: agentV1Runtime.PrepareAttempt,
  ): Promise<PreparedAttemptReceipt> {
    return this.#prepare(value);
  }

  async prepareHydrated(
    value: agentV1Runtime.PrepareAttempt,
    hydrate: () => Promise<void>,
  ): Promise<PreparedAttemptReceipt> {
    if (typeof hydrate !== 'function') {
      throw new HostLifecycleDriverError(
        'driver_failed',
        'prepared hydration callback is invalid',
      );
    }
    return this.#prepare(value, hydrate);
  }

  async #prepare(
    value: agentV1Runtime.PrepareAttempt,
    hydrate?: () => Promise<void>,
  ): Promise<PreparedAttemptReceipt> {
    try {
      this.#phase.transition('established', 'preparing');
      const receipt = await executeHostLifecyclePrepare({
        channel: this.#channel!,
        connectionId: this.#hostHello.connectionId,
        value,
        expectation: this.#preparedExpectation!,
        timeoutMs: this.#outboundTimeoutMs,
        hydrate,
        issueReceipt: (facts) => this.#receipts.mintPrepared(facts),
      });
      this.#preparedExpectation = undefined;
      this.#phase.set('prepared');
      return receipt;
    } catch (cause) {
      this.#raise(cause);
    }
  }

  async activate(
    receipt: PreparedAttemptReceipt,
  ): Promise<ActiveAttemptReceipt> {
    try {
      this.#phase.transition('prepared', 'persisting');
      const facts = this.#receipts.consumePrepared(receipt);
      const authority = snapshotPreparedActivationAuthority(
        facts,
        this.#maximumActivationDeadlineAtUnixMs,
      );
      const lifetime = new HostAuthorityLifetime(
        this.#clock!,
        this.#maximumActivationDeadlineAtUnixMs,
        (cause) => this.#fail(cause),
      );
      this.#authorityLifetime = lifetime;
      const durability = this.#durability!;
      this.#durability = undefined;
      const grant = await lifetime.commitPrepared(
        durability,
        facts,
      ).finally(() => scrubPreparedDurabilityFacts(facts));
      const activate = validateDurableActivationGrant(
        grant,
        authority,
        this.#activationAuthoritySeal!,
      );
      scrubActivationAuthoritySeal(this.#activationAuthoritySeal);
      this.#activationAuthoritySeal = undefined;
      lifetime.narrowDeadline(activate.deadlineAtUnixMs);
      const activeFacts = activeAuthorityFacts(activate, authority);
      this.#phase.set('activating');
      await sendActivateAttempt(
        this.#channel!,
        activate,
        this.#outboundTimeoutMs,
      );
      await receiveCommittedActivationAck(this.#channel!);
      const active = this.#receipts.installActive(
        activeFacts,
        lifetime.signal,
      );
      this.#phase.set('active');
      return active;
    } catch (cause) {
      this.#raise(cause);
    }
  }

  consumeActive(
    receipt: ActiveAttemptReceipt,
  ): ActiveAttemptAuthorityHandle {
    try {
      this.#phase.require('active');
      return this.#receipts.consumeActive(receipt);
    } catch (cause) {
      this.#raise(cause);
    }
  }

  inspectActive(
    handle: ActiveAttemptAuthorityHandle,
  ): ActiveAttemptAuthoritySnapshot {
    try {
      this.#phase.require('active');
      return this.#receipts.inspectActive(handle);
    } catch (cause) {
      this.#raise(cause);
    }
  }

  abort(): void {
    this.#fail(new HostLifecycleDriverError(
      'driver_failed',
      'host lifecycle driver was aborted',
    ));
  }

  tick(): void {
    try {
      this.#bootstrap?.tick();
      this.#channel?.tick();
      this.#authorityLifetime?.tick();
    } catch (cause) {
      this.#raise(cause);
    }
  }

  get isFailed(): boolean {
    return this.#phase.isFailed;
  }

  observeFailure(observer: (cause: unknown) => void): () => void {
    return this.#phase.observeFailure(observer);
  }

  #raise(cause: unknown): never {
    const failure = canonicalLifecycleFailure(cause);
    this.#fail(failure);
    throw failure;
  }

  #fail(cause: unknown): void {
    if (this.#phase.isFailed) return;
    this.#phase.fail(cause);
    this.#receipts.revokePrepared();
    this.#durability = undefined;
    this.#preparedExpectation = undefined;
    scrubActivationAuthoritySeal(this.#activationAuthoritySeal);
    this.#activationAuthoritySeal = undefined;
    this.#authorityLifetime?.abort(cause);
    this.#authorityLifetime = undefined;
    this.#bootstrap?.abort(cause);
    this.#channel?.abort(cause);
    this.#bootstrap = undefined;
    this.#channel = undefined;
    this.#clock = undefined;
  }
}
