export type AttemptFrameBootstrapErrorCode =
  | 'bootstrap_consumed'
  | 'bootstrap_order'
  | 'invalid_launch_binding'
  | 'launch_binding_consumed'
  | 'invalid_hard_cap'
  | 'invalid_expected_identity'
  | 'invalid_expected_connection'
  | 'invalid_expected_connection_token'
  | 'invalid_expected_runtime'
  | 'invalid_expected_nonce'
  | 'invalid_expected_contract'
  | 'invalid_expected_provenance'
  | 'invalid_resource_budget'
  | 'invalid_hard_deadline'
  | 'invalid_heartbeat_policy'
  | 'invalid_feature_policy'
  | 'authority_mismatch'
  | 'launch_nonce_mismatch'
  | 'runtime_instance_mismatch'
  | 'contract_mismatch'
  | 'invalid_protocol_range'
  | 'selected_protocol_unsupported'
  | 'required_feature_missing'
  | 'agent_hello_rejected'
  | 'invalid_observed_at'
  | 'deadline_expired'
  | 'wrong_sequence'
  | 'wrong_payload'
  | 'protocol_mismatch'
  | 'connection_mismatch'
  | 'connection_token_mismatch'
  | 'missing_selected_protocol'
  | 'invalid_selected_protocol'
  | 'invalid_selected_connection'
  | 'missing_frame_limits'
  | 'invalid_negotiated_maximum'
  | 'unsupported_frame_limits'
  | 'transport_limits_mismatch'
  | 'heartbeat_policy_mismatch'
  | 'feature_policy_mismatch'
  | 'physical_cap_mismatch'
  | 'unexpected_eof'
  | 'seed_channel_mismatch';

export class AttemptFrameBootstrapError extends Error {
  constructor(
    readonly code: AttemptFrameBootstrapErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AttemptFrameBootstrapError';
  }
}
