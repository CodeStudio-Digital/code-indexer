import { DelimitedChannelError } from './DelimitedChannelError.js';
import { boundedTimeout } from './DelimitedChannelTiming.js';

export interface DelimitedByteChannelOptions {
  maximumFrameBytes: number;
  maximumTransportChunkBytes?: number;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

interface ResolvedDelimitedByteChannelOptions {
  maximumFrameBytes: number;
  maximumTransportChunkBytes: number;
  readTimeoutMs: number;
  writeTimeoutMs: number;
}

const DEFAULT_TRANSPORT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

export function resolveDelimitedByteChannelOptions(
  options: DelimitedByteChannelOptions,
): ResolvedDelimitedByteChannelOptions {
  assertPositiveUint32(options.maximumFrameBytes, 'maximumFrameBytes');
  const maximumTransportChunkBytes = options.maximumTransportChunkBytes
    ?? Math.min(options.maximumFrameBytes, DEFAULT_TRANSPORT_CHUNK_BYTES);
  assertPositiveUint32(maximumTransportChunkBytes, 'maximumTransportChunkBytes');
  return Object.freeze({
    maximumFrameBytes: options.maximumFrameBytes,
    maximumTransportChunkBytes,
    readTimeoutMs: boundedTimeout(
      options.readTimeoutMs,
      DEFAULT_READ_TIMEOUT_MS,
      'readTimeoutMs',
    ),
    writeTimeoutMs: boundedTimeout(
      options.writeTimeoutMs,
      DEFAULT_WRITE_TIMEOUT_MS,
      'writeTimeoutMs',
    ),
  });
}

function assertPositiveUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new DelimitedChannelError(
      'invalid_limit',
      `${field} must be a positive uint32`,
    );
  }
}
