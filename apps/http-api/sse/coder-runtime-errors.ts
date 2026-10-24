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
