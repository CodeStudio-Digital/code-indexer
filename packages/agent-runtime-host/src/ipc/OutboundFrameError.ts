export type OutboundFrameErrorCode =
  | 'sender_poisoned'
  | 'pending_outbound_active'
  | 'invalid_clock'
  | 'invalid_deadline'
  | 'hard_deadline_expired'
  | 'invalid_correlation'
  | 'sequence_exhausted'
  | 'wrong_bootstrap_payload'
  | 'invalid_outbound_authority';

export class OutboundFrameError extends Error {
  constructor(
    readonly code: OutboundFrameErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OutboundFrameError';
  }
}
