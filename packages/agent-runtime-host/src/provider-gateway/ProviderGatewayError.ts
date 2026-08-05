export type ProviderGatewayErrorCode =
  | 'invalid_provider_request'
  | 'provider_request_too_large'
  | 'provider_registry_full'
  | 'provider_operation_conflict'
  | 'provider_operation_not_found'
  | 'provider_operation_identity_mismatch'
  | 'provider_binding_mismatch'
  | 'provider_deadline_exceeded'
  | 'provider_cancelled'
  | 'provider_failed'
  | 'provider_eof_before_done'
  | 'provider_stream_limit_exceeded'
  | 'provider_tool_stream_invalid'
  | 'provider_delta_unsupported'
  | 'provider_sink_failed';

export class ProviderGatewayError extends Error {
  constructor(
    readonly code: ProviderGatewayErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderGatewayError';
  }
}
