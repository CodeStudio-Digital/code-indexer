import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { parseSSEChunk, type SSEEvent } from './SSEFramer.js';

export class SSEStreamInterruptedError extends Error {}
const MAX_PENDING_CHARS = 2 * 1024 * 1024;

/** Node-side bounded SSE reader. Consumers decide which terminal receipt ends
 * their operation; HTTP 200 and EOF do not by themselves establish success. */
export async function* readSSEEvents(response: Response, signal: AbortSignal): AsyncGenerator<SSEEvent> {
  if (!response.body) throw new SSEStreamInterruptedError('Agent stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = ''; let trailingCR = ''; let sliceStarted = performance.now();
  const aborted = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', aborted, { once: true });
  const consume = (text: string, eof = false): SSEEvent[] => {
    let normalized = trailingCR + text;
    trailingCR = !eof && normalized.endsWith('\r') ? '\r' : '';
    if (trailingCR) normalized = normalized.slice(0, -1);
    buffer += normalized.replace(/\r\n?/g, '\n');
    if (buffer.length > MAX_PENDING_CHARS) throw new SSEStreamInterruptedError('Agent stream frame exceeds its bound');
    const parsed = parseSSEChunk(buffer, () => { throw new SSEStreamInterruptedError('Malformed agent stream frame'); });
    buffer = parsed.rest;
    return parsed.events;
  };
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { yield* consume(decoder.decode(), true); return; }
      for (let offset = 0; offset < chunk.value.byteLength; offset += 16 * 1024) {
        yield* consume(decoder.decode(chunk.value.subarray(offset, offset + 16 * 1024), { stream: true }));
        if (performance.now() - sliceStarted >= 4) {
          await yieldToEventLoop(); signal.throwIfAborted(); sliceStarted = performance.now();
        }
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof SSEStreamInterruptedError) throw error;
    throw new SSEStreamInterruptedError(`Agent stream was interrupted: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    signal.removeEventListener('abort', aborted);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
