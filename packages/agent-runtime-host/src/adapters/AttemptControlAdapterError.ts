export type AttemptControlAdapterErrorCode =
  | 'aborted'
  | 'already_opened'
  | 'invalid_connection'
  | 'invalid_launch_binding'
  | 'invalid_provision'
  | 'ownership_consumed';

export class AttemptControlAdapterError extends Error {
  constructor(
    readonly code: AttemptControlAdapterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AttemptControlAdapterError';
  }
}
