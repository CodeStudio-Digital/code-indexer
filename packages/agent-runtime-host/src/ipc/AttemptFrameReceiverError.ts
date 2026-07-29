export type AttemptFrameReceiverErrorCode =
  | 'receiver_poisoned'
  | 'invalid_seed'
  | 'unsupported_channel'
  | 'invalid_replay_window'
  | 'replay_window_too_large'
  | 'invalid_total_identity_capacity'
  | 'invalid_replay_byte_budget'
  | 'identity_capacity_exhausted'
  | 'replay_byte_budget_exhausted'
  | 'invalid_observed_at'
  | 'deadline_expired'
  | 'direction_mismatch'
  | 'protocol_mismatch'
  | 'connection_mismatch'
  | 'runtime_instance_mismatch'
  | 'correlation_mismatch'
  | 'identity_mismatch'
  | 'message_id_conflict'
  | 'message_id_retired'
  | 'sequence_mismatch'
  | 'sequence_exhausted'
  | 'pending_inbound_active'
  | 'pending_payload_consumed'
  | 'invalid_pending'
  | 'invalid_replay_outcome'
  | 'invalid_replay_response'
  | 'unexpected_eof';

export class AttemptFrameReceiverError extends Error {
  constructor(
    readonly code: AttemptFrameReceiverErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AttemptFrameReceiverError';
  }
}
