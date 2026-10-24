import type { AgentRuntimeAdapterPort } from './ports.js';
import type { AttemptAuthority, CancelReason, ExecutableAgentAttempt } from './types.js';
import type { AgentRuntimeGeneration, RuntimeRouteRecord } from '../router/types.js';
import { AgentRuntimeHostError } from '../errors.js';

export interface AttemptRuntimeLease {
  cancel(reason: CancelReason): Promise<void>;
  /** Resolves only when the worker/process and its owned resources are gone. */
  closed: Promise<void>;
}

export interface AttemptRuntimeLauncher {
  assertCurrent(authority: AttemptAuthority): Promise<void>;
  /** Cleanup still verifies exact ownership, but may outlive active execution
   * authority (for example, after an ancestor's cancellation is committed). */
  assertCancellationAuthority?(authority: AttemptAuthority): Promise<void>;
  launch(prepared: ExecutableAgentAttempt, route: RuntimeRouteRecord, signal: AbortSignal): Promise<AttemptRuntimeLease>;
}

interface OwnedAttempt {
  readonly fingerprint: string;
  readonly authority: AttemptAuthority;
  readonly controller: AbortController;
  launch: Promise<void>;
  lease?: AttemptRuntimeLease;
  cancel?: Promise<void>;
  closed: boolean;
}

/** Keeps ambiguous launches in the registry: retrying start must never launch
 * a second executor with the same attempt identity. */
export class OwnedAttemptAdapter implements AgentRuntimeAdapterPort {
  private readonly attempts = new Map<string, OwnedAttempt>();

  constructor(readonly generation: AgentRuntimeGeneration, private readonly launcher: AttemptRuntimeLauncher,
    private readonly maximumAttempts = 10_000) {
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) throw new RangeError('maximumAttempts');
  }

  async launch(prepared: ExecutableAgentAttempt, route: RuntimeRouteRecord): Promise<void> {
    if (route.runtimeGeneration !== this.generation || route.attemptId !== prepared.authority.attemptId
      || route.agentRunId !== prepared.authority.agentRunId || route.sessionId !== prepared.authority.sessionId) {
      throw conflict('route does not own the prepared attempt');
    }
    const fingerprint = Buffer.from(prepared.expectedSpecSha256).toString('hex');
    const existing = this.attempts.get(prepared.authority.attemptId);
    if (existing) {
      assertSameAuthority(existing.authority, prepared.authority);
      if (existing.fingerprint !== fingerprint) throw conflict('attempt launch input changed');
      return existing.launch;
    }
    if (this.attempts.size >= this.maximumAttempts) throw conflict('attempt registry capacity reached');
    const owned: OwnedAttempt = {
      fingerprint, authority: { ...prepared.authority }, controller: new AbortController(),
      launch: Promise.resolve(), closed: false,
    };
    this.attempts.set(prepared.authority.attemptId, owned);
    // Store before invoking any asynchronous owner, including authority checks.
    owned.launch = Promise.resolve().then(async () => {
      await this.launcher.assertCurrent(owned.authority);
      owned.controller.signal.throwIfAborted();
      const lease = await this.launcher.launch(prepared, route, owned.controller.signal);
      owned.lease = lease;
      void lease.closed.then(() => { owned.closed = true; owned.lease = undefined; }, () => {
        // A failed close remains unresolved; keep ownership for cancellation.
      });
      if (owned.controller.signal.aborted) {
        await lease.cancel(owned.controller.signal.reason as CancelReason);
      }
    });
    return owned.launch;
  }

  async cancel(authority: AttemptAuthority, reason: CancelReason): Promise<void> {
    const owned = this.attempts.get(authority.attemptId);
    if (!owned) throw conflict('attempt is not owned by this adapter');
    assertSameAuthority(owned.authority, authority);
    if (this.launcher.assertCancellationAuthority) await this.launcher.assertCancellationAuthority(authority);
    else await this.launcher.assertCurrent(authority);
    if (owned.cancel) return owned.cancel;
    owned.cancel = (async () => {
      if (owned.closed) return;
      if (owned.lease) return owned.lease.cancel(reason);
      owned.controller.abort(reason);
      // The launcher owns cleanup on failure. A late successful launch sees
      // the aborted signal above and cancels its newly acquired lease.
      await owned.launch.catch(() => undefined);
    })();
    return owned.cancel;
  }
}

function assertSameAuthority(expected: AttemptAuthority, actual: AttemptAuthority): void {
  for (const key of ['sessionId', 'commandId', 'agentRunId', 'attemptId', 'executorOwnerId',
    'fencingEpoch', 'correlationId', 'rootAgentRunId'] as const) {
    if (expected[key] !== actual[key]) throw conflict(`attempt authority changed: ${key}`);
  }
}

function conflict(message: string): AgentRuntimeHostError {
  return new AgentRuntimeHostError('prepared_attempt_mismatch', message);
}
