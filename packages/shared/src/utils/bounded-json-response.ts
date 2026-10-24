/** Bound decoded JSON, including the time spent receiving its body. */
export async function readBoundedJsonResponse(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  signal.throwIfAborted();
  if (!response.body) return null;
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const parts: Uint8Array[] = []; let size = 0, complete = false;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error(`JSON response exceeds ${maxBytes} bytes`);
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`JSON response exceeds ${maxBytes} bytes`);
      parts.push(value);
    }
    return size ? JSON.parse(Buffer.concat(parts, size).toString('utf8')) : null;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    await cancellation;
    reader.releaseLock();
  }
}
