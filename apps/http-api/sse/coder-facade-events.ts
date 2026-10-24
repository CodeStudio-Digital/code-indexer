import { createHash } from 'node:crypto';
import { asRuntimeEventId } from '@mcp/agent-runtime-contracts';
import type { CanonicalAgentEvent, EventCursor } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { BufferedEvent, CoderRunBus } from '../coder-bus.js';

export const coderStreamIdentity = (bus: CoderRunBus) => ({
  id: bus.busId, durability: 'volatile' as const, sequenceScope: 'stream' as const,
});

function envelope(bus: CoderRunBus, context: ControlPlaneRunContext, row: BufferedEvent, namespace: string): CanonicalAgentEvent {
  const hex = createHash('sha256').update(`${bus.busId}:${row.seq}`).digest('hex');
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const at = row.occurredAt ?? new Date().toISOString();
  return {
    schemaVersion: 1, eventId: asRuntimeEventId(eventId), eventClass: 'E',
    partitionKey: bus.busId, globalSeq: row.seq,
    sessionId: context.sessionId, commandId: context.commandId, agentRunId: context.agentRunId,
    attemptId: context.attemptId, correlationId: context.correlationId, actor: context.actor,
    type: `${namespace}.${row.event}`, occurredAt: at, recordedAt: at,
    payload: row.data, payloadHash: createHash('sha256').update(JSON.stringify(row.data) ?? 'null').digest('hex'),
    redaction: { policyVersion: `${namespace}-coder-bus-v1`, fields: [], secretRefs: [] },
    stream: coderStreamIdentity(bus),
  };
}

/** Reuse the bounded bus; never build an unbounded queue per slow subscriber.
 * A gap requires a transcript/snapshot refresh, not silent loss or fake replay. */
export function subscribeCoderFacadeEvents(bus: CoderRunBus, context: ControlPlaneRunContext,
  cursor?: EventCursor, namespace: 'legacy' = 'legacy'): AsyncIterable<CanonicalAgentEvent> {
  return { [Symbol.asyncIterator]() {
    let stopped = false;
    let wake: (() => void) | undefined;
    let after = cursor?.afterGlobalSeq ?? -1;
    const iterator = (async function* () {
      if (!Number.isSafeInteger(after) || after < -1 || after > (bus.ended ? bus.nextSeq : bus.nextSeq - 1)
        || (cursor && cursor.streamId !== bus.busId)) throw new Error('Runtime event cursor belongs to another stream');
      while (!stopped) {
        const first = bus.buffer[0]?.seq ?? bus.nextSeq;
        if (after < first - 1) throw new Error('Runtime event cursor expired; refresh the transcript and snapshot');
        const row = bus.buffer[after + 1 - first];
        if (row && row.seq !== after + 1) throw new Error('Runtime event replay has a sequence gap');
        if (row) { after = row.seq; yield envelope(bus, context, row, namespace); continue; }
        if (bus.ended) {
          if (after < bus.nextSeq && bus.endReason) {
            after = bus.nextSeq;
            yield envelope(bus, context, { seq: after, ...bus.endReason }, namespace);
          }
          return;
        }
        await new Promise<void>((resolve) => {
          wake = () => {
            bus.subscribers.delete(onEvent);
            bus.endListeners.delete(onEnd);
            wake = undefined;
            resolve();
          };
          const onEvent = () => wake?.();
          const onEnd = () => wake?.();
          bus.subscribers.add(onEvent);
          bus.endListeners.add(onEnd);
        });
      }
    })();
    return {
      next: () => iterator.next(),
      return: async () => { stopped = true; wake?.(); return iterator.return(); },
      throw: async (error?: unknown) => { stopped = true; wake?.(); return iterator.throw(error); },
    };
  } };
}
