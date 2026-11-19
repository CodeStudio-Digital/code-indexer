/** A damaged session must not make the authority unavailable to other sessions. */
export class SessionRecoveryError extends Error {
  readonly code = 'SESSION_RECOVERY_UNAVAILABLE';

  constructor(readonly sessionId: string, cause: unknown) {
    super(`Session ${sessionId} storage could not be recovered. Check that its project and session files are accessible, then retry. The request was not executed.`, { cause });
    this.name = 'SessionRecoveryError';
  }
}

export function sessionRecoveryFailure(error: unknown): { error: string; code: string; session_id: string } | undefined {
  return error instanceof SessionRecoveryError
    ? { error: error.message, code: error.code, session_id: error.sessionId }
    : undefined;
}
