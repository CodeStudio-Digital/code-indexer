export type DelimitedChannelErrorCode =
  | 'invalid_limit'
  | 'concurrent_read'
  | 'concurrent_write'
  | 'read_timeout'
  | 'write_timeout'
  | 'channel_owned'
  | 'channel_failed'
  | 'transport_chunk_too_large'
  | 'truncated_length'
  | 'length_overflow'
  | 'non_canonical_length'
  | 'empty_frame'
  | 'frame_too_large'
  | 'truncated_frame'
  | 'transport_error';

export class DelimitedChannelError extends Error {
  constructor(
    readonly code: DelimitedChannelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DelimitedChannelError';
  }
}
