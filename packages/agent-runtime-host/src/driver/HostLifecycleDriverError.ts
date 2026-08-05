export type HostLifecycleDriverErrorCode =
  | 'driver_failed'
  | 'invalid_order'
  | 'invalid_receipt'
  | 'unexpected_payload'
  | 'invalid_prepared_expectation'
  | 'prepared_facts_mismatch'
  | 'invalid_durable_authority'
  | 'active_authority_revoked'
  | 'invalid_channel_receipt'
  | 'invalid_heartbeat'
  | 'heartbeat_timeout'
  | 'invalid_active_command'
  | 'command_ack_timeout';

export class HostLifecycleDriverError extends Error {
  constructor(
    readonly code: HostLifecycleDriverErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HostLifecycleDriverError';
  }
}
