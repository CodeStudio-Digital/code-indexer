export type HostDataChannelErrorCode =
  | 'invalid_provision'
  | 'invalid_binding'
  | 'invalid_hydration'
  | 'provider_failure'
  | 'unexpected_payload'
  | 'source_failure';

export class HostDataChannelError extends Error {
  readonly code: HostDataChannelErrorCode;

  constructor(
    code: HostDataChannelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HostDataChannelError';
    this.code = code;
  }
}
