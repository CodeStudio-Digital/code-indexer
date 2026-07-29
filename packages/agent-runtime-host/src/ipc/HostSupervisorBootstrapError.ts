export type HostSupervisorBootstrapErrorCode =
  | 'invalid_provision'
  | 'physical_cap_mismatch'
  | 'wrong_bootstrap_order'
  | 'unexpected_eof'
  | 'invalid_frame'
  | 'invalid_header'
  | 'wrong_bootstrap_payload'
  | 'protocol_mismatch'
  | 'connection_mismatch'
  | 'contract_mismatch'
  | 'provenance_mismatch'
  | 'nonce_mismatch'
  | 'feature_mismatch'
  | 'containment_mismatch'
  | 'invalid_launch'
  | 'launch_capability_consumed'
  | 'transport_failure';

export class HostSupervisorBootstrapError extends Error {
  constructor(
    readonly code: HostSupervisorBootstrapErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HostSupervisorBootstrapError';
  }
}
