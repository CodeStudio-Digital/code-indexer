import { clone } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { type AuthorityClock } from '../ipc/AttemptClock.js';
import type { AcceptedAgentHello } from '../ipc/AgentHelloSummary.js';
import { type EstablishedAttemptChannel } from '../ipc/EstablishedAttemptChannel.js';
import { scrubActivationAuthoritySeal } from '../ipc/ActivationAuthoritySealValidation.js';
import { HostBootstrapAttemptChannel, createHostBootstrapAttemptChannelWithClock } from '../ipc/HostBootstrapAttemptChannel.js';
import { HostAuthorityLifetime } from './HostAuthorityLifetime.js';
import { HostHeartbeatMonitor } from './HostHeartbeatMonitor.js';
import { HostLifecycleDriverError } from './HostLifecycleDriverError.js';
import { takeLifecycleDriverClock } from './HostLifecycleDriverConstruction.js';
import { canonicalLifecycleFailure } from './HostLifecycleFailure.js';
import { HostLifecycleDriverPhase } from './HostLifecycleDriverState.js';
import type { ActiveAttemptAuthorityHandle, ActiveAttemptReceipt, PreparedAttemptReceipt } from './HostLifecycleReceipts.js';
import { executeHostLifecycleActivation } from './HostLifecycleActivate.js';
import { HostLifecycleReceiptOwner } from './HostLifecycleReceiptOwner.js';
import type {
  ActiveAttemptAuthoritySnapshot, HostAttemptLifecycleDriverOptions,
  HostCancelAttemptRequest, HostFenceAttemptRequest,
  PreparedDurabilityPort, PreparedFactsExpectation,
} from './HostLifecycleTypes.js';
import { consumeHostLifecycleLaunchBinding } from './HostLifecycleLaunchAuthority.js';
import { executeHostLifecyclePrepare } from './HostLifecyclePrepare.js';
import { HostLifecycleTerminator } from './HostLifecycleTerminator.js';

export class HostAttemptLifecycleDriver {
  readonly #receipts = new HostLifecycleReceiptOwner();
  readonly #hostHello: agentV1Runtime.HostHello;
  readonly #outboundTimeoutMs: number;
  #durability?: PreparedDurabilityPort;
  #preparedExpectation?: PreparedFactsExpectation;
  #clock?: AuthorityClock;
  #authorityLifetime?: HostAuthorityLifetime;
  #heartbeat?: HostHeartbeatMonitor;
  #terminator?: HostLifecycleTerminator;
  #activationAuthoritySeal?: agentV1Common.ActivationAuthoritySeal;
  #maximumActivationDeadlineAtUnixMs: bigint;
  #bootstrap?: HostBootstrapAttemptChannel;
  #channel?: EstablishedAttemptChannel;
  readonly #phase = new HostLifecycleDriverPhase();

  constructor(options: HostAttemptLifecycleDriverOptions) {
    const launch = consumeHostLifecycleLaunchBinding(options.launch);
    this.#hostHello = clone(agentV1Runtime.HostHelloSchema, options.hostHello);
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
      const durability = this.#durability!;
      this.#durability = undefined;
      const result = await executeHostLifecycleActivation({
        receipt,
        receipts: this.#receipts,
        clock: this.#clock!,
        maximumDeadlineAtUnixMs: this.#maximumActivationDeadlineAtUnixMs,
        durability,
        activationSeal: this.#activationAuthoritySeal!,
        channel: this.#channel!,
        outboundTimeoutMs: this.#outboundTimeoutMs,
        heartbeatTimeoutMs: this.#hostHello.heartbeatTimeoutMs,
        failOwner: (cause) => this.#fail(cause),
        retainLifetime: (value) => { this.#authorityLifetime = value; },
        setPhase: (value) => this.#phase.set(value),
      });
      this.#activationAuthoritySeal = undefined;
      this.#heartbeat = result.heartbeat;
      this.#terminator = new HostLifecycleTerminator({
        receipts: this.#receipts,
        phase: this.#phase,
        channel: this.#channel!,
        monitor: result.heartbeat,
        lifetime: this.#authorityLifetime!,
        timeoutMs: this.#outboundTimeoutMs,
        release: () => {
          this.#heartbeat = undefined;
          this.#authorityLifetime = undefined;
          this.#terminator = undefined;
        },
        raise: (cause) => this.#raise(cause),
      });
      return result.active;
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
      return Object.freeze({
        ...this.#receipts.inspectActive(handle),
        heartbeat: this.#heartbeat?.inspect(),
        remainingControlIdentities: this.#channel?.remainingInboundIdentities,
      });
    } catch (cause) {
      this.#raise(cause);
    }
  }

  async cancel(handle: ActiveAttemptAuthorityHandle, request: HostCancelAttemptRequest): Promise<void> {
    this.#phase.require('active');
    return this.#terminator!.cancel(handle, request);
  }

  async fence(handle: ActiveAttemptAuthorityHandle, request: HostFenceAttemptRequest): Promise<void> {
    this.#phase.require('active');
    return this.#terminator!.fence(handle, request);
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
      this.#heartbeat?.tick();
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
    this.#heartbeat?.close(cause);
    this.#heartbeat = undefined;
    this.#terminator = undefined;
    this.#bootstrap?.abort(cause);
    this.#channel?.abort(cause);
    this.#bootstrap = undefined;
    this.#channel = undefined;
    this.#clock = undefined;
  }
}
