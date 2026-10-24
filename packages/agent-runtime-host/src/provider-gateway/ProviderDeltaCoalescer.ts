import { performance } from 'node:perf_hooks';
import type { ChatDelta } from '@mcp/provider-sdk/wire.js';
import { raceAbort } from './ProviderAbort.js';
import { ProviderGatewayError } from './ProviderGatewayError.js';
import type { ProviderGatewayLimits } from './ProviderGatewayTypes.js';

type TextDelta = Extract<ChatDelta, { type: 'text_delta' | 'thinking_delta' }>;
const FLUSH_MS = 16;
const BATCH_BYTES = 16 * 1024;
const BATCH_DELTAS = 256;
const FLUSH = Symbol('flush');

/** One pending read, bounded text, and no background producer. The first delta
 * of each content segment remains immediate; tools and usage are barriers. */
export async function* coalesceProviderDeltas(
  iterator: AsyncIterator<ChatDelta>, signal: AbortSignal, limits: ProviderGatewayLimits,
): AsyncGenerator<ChatDelta> {
  let pending: Promise<IteratorResult<ChatDelta>> | undefined;
  let batch: TextDelta | undefined;
  let previous: TextDelta | undefined;
  let batchBytes = 0, batchCount = 0, events = 0, flushAt = 0;
  const maximumBytes = Math.min(BATCH_BYTES, limits.maxEventBytes);
  try {
    for (;;) {
      signal.throwIfAborted();
      if (!pending) {
        pending = raceAbort(iterator.next(), signal);
        // A timed flush may yield while this single lookahead rejects.
        void pending.catch(() => undefined);
      }
      const next = batch ? await nextOrFlush(pending, flushAt - performance.now()) : await pending;
      if (next === FLUSH) {
        const ready = batch!; batch = undefined;
        yield ready;
        continue;
      }
      pending = undefined;
      if (next.done) { if (batch) yield batch; return; }
      // Count and validate raw deltas, so batching cannot bypass provider caps.
      const delta = next.value;
      if (++events > limits.maxStreamEvents) throw streamLimit('provider stream event ceiling exceeded');
      const text = delta.type === 'text_delta' || delta.type === 'thinking_delta';
      const bytes = text ? Buffer.byteLength(delta.text) : 0;
      if (bytes > limits.maxEventBytes) throw streamLimit('provider event exceeds byte ceiling');
      if (!text || bytes === 0 || bytes > maximumBytes) {
        if (batch) { const ready = batch; batch = undefined; yield ready; }
        previous = undefined;
        yield delta;
        continue;
      }
      if (batch && (!compatible(batch, delta) || batchBytes + bytes > maximumBytes)) {
        const ready = batch; batch = undefined; yield ready;
      }
      if (!previous || !compatible(previous, delta)) {
        previous = delta;
        yield delta;
      } else if (!batch) {
        batch = { ...delta }; batchBytes = bytes; batchCount = 1;
        flushAt = performance.now() + FLUSH_MS;
      } else {
        batch.text += delta.text; batchBytes += bytes; batchCount++;
      }
      if (batch && (batchBytes >= maximumBytes || batchCount >= BATCH_DELTAS)) {
        const ready = batch; batch = undefined; yield ready;
      }
    }
  } catch (cause) {
    if (batch && !signal.aborted) yield batch;
    throw cause;
  }
}

function compatible(left: TextDelta, right: TextDelta): boolean {
  return left.type === right.type && (left.type === 'thinking_delta'
    || (right.type === 'text_delta' && left.itemId === right.itemId && left.phase === right.phase));
}

async function nextOrFlush<T>(next: Promise<T>, remainingMs: number): Promise<T | typeof FLUSH> {
  if (remainingMs <= 0) return FLUSH;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([next, new Promise<typeof FLUSH>(resolve => {
      timer = setTimeout(() => resolve(FLUSH), remainingMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function streamLimit(message: string): ProviderGatewayError {
  return new ProviderGatewayError('provider_stream_limit_exceeded', message);
}
