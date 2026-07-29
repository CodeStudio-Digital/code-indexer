export type RustHostAttemptCoordinatorErrorCode =
  | 'already_started'
  | 'aborted'
  | 'management_sequence'
  | 'management_barrier';

export class RustHostAttemptCoordinatorError extends Error {
  readonly code: RustHostAttemptCoordinatorErrorCode;

  constructor(
    code: RustHostAttemptCoordinatorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RustHostAttemptCoordinatorError';
    this.code = code;
  }
}

export function rustHostAttemptAborted(
  cause?: unknown,
): RustHostAttemptCoordinatorError {
  return new RustHostAttemptCoordinatorError(
    'aborted',
    'Rust Host attempt composition was aborted',
    cause === undefined ? undefined : { cause },
  );
}

export function rustHostManagementSequenceFailure(
  message: string,
): RustHostAttemptCoordinatorError {
  return new RustHostAttemptCoordinatorError('management_sequence', message);
}
