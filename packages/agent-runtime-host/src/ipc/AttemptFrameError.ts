export type AttemptFrameErrorCode =
  | 'empty_frame'
  | 'frame_too_large'
  | 'invalid_frame_limit'
  | 'malformed_frame'
  | 'missing_header'
  | 'invalid_protocol_version'
  | 'invalid_header_identifier'
  | 'invalid_fencing_epoch'
  | 'invalid_stream_seq'
  | 'invalid_sent_at'
  | 'invalid_deadline'
  | 'unsupported_channel'
  | 'channel_mismatch'
  | 'empty_payload'
  | 'invalid_payload_digest'
  | 'payload_digest_mismatch'
  | 'malformed_payload'
  | 'missing_payload_body'
  | 'missing_payload_identity'
  | 'invalid_payload_identity'
  | 'payload_identity_mismatch'
  | 'payload_not_allowed_on_channel';

export class AttemptFrameError extends Error {
  constructor(
    readonly code: AttemptFrameErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AttemptFrameError';
  }
}
