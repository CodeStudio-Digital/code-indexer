import { DelimitedChannelError } from './DelimitedChannelError.js';

const MAX_TRANSPORT_TIMEOUT_MS = 5 * 60_000;

export function boundedTimeout(
  candidate: number | undefined,
  fallback: number,
  field: string,
): number {
  const value = candidate ?? fallback;
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_TRANSPORT_TIMEOUT_MS
  ) {
    throw new DelimitedChannelError(
      'invalid_limit',
      `${field} must be a bounded positive integer`,
    );
  }
  return value;
}

export async function withTransportTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: 'read_timeout' | 'write_timeout',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DelimitedChannelError(
        code,
        `transport ${code.replace('_', ' ')}`,
      ));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
