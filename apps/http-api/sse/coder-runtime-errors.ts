/** A negative worker acknowledgement is safe to handle as a parked interaction.
 * A missing acknowledgement is deliberately not represented by this error. */
export class CoderInteractionNotPendingError extends Error {
  readonly code = 'INTERACTION_NOT_PENDING';
  constructor() { super('Interaction is no longer pending'); }
}

export function isCoderInteractionNotPendingError(error: unknown): boolean {
  return error instanceof CoderInteractionNotPendingError || (!!error && typeof error === 'object'
    && 'code' in error && error.code === 'INTERACTION_NOT_PENDING');
}

/** Only the worker's pre-dispatch stopping guard emits this negative acknowledgement. */
export class CoderWorkerStoppingError extends Error {
  readonly code = 'CODER_WORKER_STOPPING';
  constructor() { super('The previous session worker is stopping.'); }
}

export function isCoderWorkerStoppingError(error: unknown): error is CoderWorkerStoppingError {
  return error instanceof Error && 'code' in error && error.code === 'CODER_WORKER_STOPPING';
}

export class CoderWorkerDrainError extends Error {
  readonly code = 'CODER_WORKER_DRAINING';
  constructor(cause: unknown) {
    super('The previous worker has not finished releasing this conversation. Try sending again in this chat.', { cause });
  }
}

/** A follow-up addressed to a finished run was refused before any write. */
export class CoderTurnEndedError extends Error {
  readonly code = 'CODER_TURN_ENDED_BEFORE_INPUT';
  constructor() { super('The previous turn finished before this message could be queued. Send it again in this chat.'); }
}

/** Boot and writer acquisition both precede dispatch of the user's run. */
export class CoderWorkerBootError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The session worker could not start.', { cause });
  }
}

export class CoderWriterRecoveryTimeoutError extends Error {}

const setupMessages: Readonly<Record<string, string>> = {
  'session-recovery-timeout': 'Session history preparation timed out before your message reached the provider. You can retry in this chat.',
  'worker-draining': 'The previous worker is still releasing this conversation. Send the message again in this chat.',
  'turn-ended-before-input': 'The previous turn finished before this message could be queued. Send it again in this chat.',
  'worker-unavailable-before-input': 'The session worker could not start. Your message was not processed. Try again in this chat.',
  'session-writer-busy': 'Another writer still holds this conversation. Wait for it to finish and try again.',
  'worker-runFresh-failed': 'The worker could not start this turn. The worker log contains the original error.',
  'request-setup-failed': 'The conversation could not prepare this message. Check the worker log for the original error.',
  'continue-setup-failed': 'The conversation could not prepare the continuation. Check the worker log for the original error.',
};

export function coderSetupFailure(reason: string, error?: unknown) {
  if (isCoderWorkerStoppingError(error) || error instanceof CoderWorkerDrainError) reason = 'worker-draining';
  else if (error instanceof Error && 'code' in error && error.code === 'CODER_TURN_ENDED_BEFORE_INPUT') reason = 'turn-ended-before-input';
  else if (error instanceof CoderWorkerBootError) reason = error.cause instanceof CoderWriterRecoveryTimeoutError
    ? 'session-recovery-timeout' : 'worker-unavailable-before-input';
  else if (error instanceof Error && error.name === 'SessionLeaseHeldError') reason = 'session-writer-busy';
  return {
    reason,
    ...(Object.hasOwn(setupMessages, reason) ? { message: setupMessages[reason] } : {}),
    // Only these worker lifecycle guards provide a negative execution acknowledgement.
    ...(['worker-draining', 'turn-ended-before-input', 'worker-unavailable-before-input', 'session-recovery-timeout'].includes(reason) ? { not_started: true } : {}),
  };
}

/** Missing startup ACK plus missing drain proof cannot authorize replacement. */
export class CoderStartupUncertainError extends Error {
  readonly code = 'CODER_STARTUP_UNCERTAIN';
  constructor(cause: unknown) {
    super('Startup acknowledgement was lost and worker cleanup is unconfirmed; the original attempt requires reconciliation', { cause });
  }
}

export function isCoderStartupUncertainError(error: unknown): error is CoderStartupUncertainError {
  return error instanceof CoderStartupUncertainError || (!!error && typeof error === 'object'
    && 'code' in error && error.code === 'CODER_STARTUP_UNCERTAIN');
}
