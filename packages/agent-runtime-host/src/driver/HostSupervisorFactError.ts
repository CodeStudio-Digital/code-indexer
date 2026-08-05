export type HostSupervisorFactErrorCode =
  | 'integration_incomplete'
  | 'invalid_handoff'
  | 'channel_poisoned'
  | 'unexpected_eof'
  | 'invalid_frame'
  | 'invalid_header'
  | 'protocol_mismatch'
  | 'connection_mismatch'
  | 'payload_direction'
  | 'sequence_mismatch'
  | 'message_id_conflict'
  | 'message_id_retired'
  | 'identity_capacity_exhausted'
  | 'replay_capacity_exhausted'
  | 'ack_frame_too_large'
  | 'pending_fact_active'
  | 'invalid_pending_fact'
  | 'invalid_fact'
  | 'invalid_command'
  | 'command_ack_timeout'
  | 'invalid_lifecycle_order'
  | 'durable_commit_failed'
  | 'durable_commit_timeout'
  | 'aborted'
  | 'transport_failure';

export class HostSupervisorFactError extends Error {
  constructor(
    readonly code: HostSupervisorFactErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HostSupervisorFactError';
  }
}
