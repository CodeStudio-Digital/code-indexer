import {
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import {
  type AcceptedAgentHello,
  summarizeAgentHello,
} from './AgentHelloSummary.js';
import type { AuthorityClock } from './AttemptClock.js';
import { AttemptDeadlineGuard } from './AttemptDeadlineGuard.js';
import { AttemptFrameBootstrapError } from './AttemptFrameBootstrapError.js';
import type { BootstrapAgentHello } from './AttemptFrameBootstrapModels.js';
import { bootstrapConsumed } from './AttemptFrameBootstrapModels.js';
import { BootstrapReceiver } from './AttemptFrameBootstrapReceiver.js';
import {
  type BootstrapHandoffAuthority,
  establishAttemptChannel,
  snapshotBootstrapHandoff,
} from './HostBootstrapHandoff.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import type { EstablishedAttemptChannel } from './EstablishedAttemptChannel.js';
import {
  type HostLaunchBinding,
  type HostLaunchState,
  consumeHostLaunchBinding,
} from './HostLaunchAuthority.js';
import {
  type AgentHelloSelection,
  validateAgentHelloForLaunch,
} from './HostLaunchValidation.js';
import {
  CONTROL_HARD_MAXIMUM,
  type HostBootstrapState,
  bindHostBootstrapConstruction,
  takeHostBootstrapConstruction,
} from './HostBootstrapConstruction.js';

export type { HostLaunchBinding } from './HostLaunchAuthority.js';
export type { AcceptedAgentHello } from './AgentHelloSummary.js';

export interface HostBootstrapAttemptChannelOptions {
  readonly launch: HostLaunchBinding;
}

export class HostBootstrapAttemptChannel {
  readonly #owner = {};
  readonly #binding = {};
  #transport?: DelimitedByteChannel;
  #launch?: HostLaunchState;
  #handoff?: BootstrapHandoffAuthority;
  #clock?: AuthorityClock;
  #deadlines?: AttemptDeadlineGuard;
  #receiver?: BootstrapReceiver;
  #failureObserver?: (cause: unknown) => void;
  #state: HostBootstrapState = 'awaiting_agent_hello';
  #acceptedHello?: BootstrapAgentHello;
  #agentSelection?: AgentHelloSelection;

  constructor(options: HostBootstrapAttemptChannelOptions) {
    const launch = consumeHostLaunchBinding(options.launch);
    this.#transport = launch.transport;
    this.#launch = launch;
    this.#handoff = snapshotBootstrapHandoff(launch);
    const construction = takeHostBootstrapConstruction(options);
    this.#clock = construction.clock;
    this.#failureObserver = construction.failureObserver;
    this.#transport.claim(this.#owner);
    try {
      if (this.#transport.maximumFrameBytes !== CONTROL_HARD_MAXIMUM) {
        throw new AttemptFrameBootstrapError(
          'physical_cap_mismatch',
          'bootstrap physical cap must equal the control hard cap',
        );
      }
      this.#receiver = new BootstrapReceiver(
        launch.expectedIdentity,
        'runner_to_host',
        CONTROL_HARD_MAXIMUM,
        this.#binding,
        launch.expectedConnectionId,
        launch.expectedRuntimeInstanceId,
        launch.supportedProtocols,
      );
      this.#deadlines = new AttemptDeadlineGuard(
        this.#clock,
        launch.hardDeadlineAtUnixMs,
        launch.maximumResponseTimeoutMs,
        (cause) => this.#fail(cause),
      );
      this.#deadlines.start();
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    }
  }

  async receiveAgentHello(): Promise<AcceptedAgentHello> {
    this.#assertState('awaiting_agent_hello');
    this.#state = 'receiving_agent_hello';
    try {
      const encoded = await this.#transport!.receive(this.#owner);
      this.#assertContinuing('receiving_agent_hello');
      if (!encoded) {
        throw new AttemptFrameBootstrapError(
          'unexpected_eof',
          'bootstrap ended before AgentHello',
        );
      }
      const outcome = this.#receiver!.receive(
        encoded,
        () => this.#clock!.now(),
      );
      if (outcome.kind !== 'agent_hello') {
        throw new AttemptFrameBootstrapError(
          'wrong_payload',
          'host bootstrap requires AgentHello',
        );
      }
      const hello = outcome.hello.takeHello();
      const selection = validateAgentHelloForLaunch(
        hello,
        this.#launch!,
        outcome.hello.headerProtocolVersion(),
      );
      const summary = summarizeAgentHello(hello, selection);
      this.#launch = undefined;
      this.#agentSelection = selection;
      this.#acceptedHello = outcome.hello;
      this.#state = 'agent_hello_accepted';
      return summary;
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    }
  }

  async establish(
    hostHello: agentV1Runtime.HostHello,
  ): Promise<EstablishedAttemptChannel> {
    this.#assertState('agent_hello_accepted');
    this.#state = 'sending_host_hello';
    try {
      const established = await establishAttemptChannel({
        authority: this.#handoff!,
        acceptedHello: this.#acceptedHello!,
        agentSelection: this.#agentSelection!,
        hostHello,
        transport: this.#transport!,
        hardMaximum: CONTROL_HARD_MAXIMUM,
        binding: this.#binding,
        owner: this.#owner,
        clock: this.#clock!,
        failureObserver: this.#failureObserver,
      });
      this.#state = 'handed_off';
      this.#release();
      return established;
    } catch (cause) {
      this.#fail(cause);
      throw cause;
    }
  }

  abort(cause: unknown = new AttemptFrameBootstrapError(
      'bootstrap_consumed',
      'host bootstrap was aborted',
    )): void {
    this.#fail(cause);
  }

  tick(): void {
    this.#deadlines?.tick();
  }

  get isPoisoned(): boolean {
    return this.#state === 'failed' || this.#transport?.isFailed === true;
  }

  #assertState(expected: HostBootstrapState): void {
    if (this.#state === 'handed_off') throw bootstrapConsumed();
    if (this.#state !== expected) {
      const error = new AttemptFrameBootstrapError(
        'bootstrap_order',
        `bootstrap state ${this.#state} cannot perform ${expected}`,
      );
      this.#fail(error);
      throw error;
    }
  }

  #assertContinuing(expected: HostBootstrapState): void {
    if (this.#state !== expected) {
      throw new AttemptFrameBootstrapError(
        'bootstrap_order',
        'bootstrap operation lost physical ownership',
      );
    }
  }

  #fail(cause: unknown): void {
    if (this.#state === 'handed_off' || this.#state === 'failed') return;
    this.#state = 'failed';
    const observer = this.#failureObserver;
    try {
      this.#transport?.fail(cause, this.#owner);
    } finally {
      this.#release();
      observer?.(cause);
    }
  }

  #release(): void {
    this.#deadlines?.close();
    this.#launch = undefined;
    this.#handoff = undefined;
    this.#receiver = undefined;
    this.#acceptedHello = undefined;
    this.#agentSelection = undefined;
    this.#transport = undefined;
    this.#clock = undefined;
    this.#deadlines = undefined;
    this.#failureObserver = undefined;
  }
}

/** Internal test seam; unavailable through the package export map. */
export function createHostBootstrapAttemptChannelForTesting(
  options: HostBootstrapAttemptChannelOptions,
  clock: AuthorityClock,
): HostBootstrapAttemptChannel {
  return createHostBootstrapAttemptChannelWithClock(options, clock);
}

/** Internal composition seam; unavailable through the package export map. */
export function createHostBootstrapAttemptChannelWithClock(
  options: HostBootstrapAttemptChannelOptions,
  clock: AuthorityClock,
  failureObserver?: (cause: unknown) => void,
): HostBootstrapAttemptChannel {
  bindHostBootstrapConstruction(options, clock, failureObserver);
  return new HostBootstrapAttemptChannel(options);
}
