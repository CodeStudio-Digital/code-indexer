import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getAgentSessionSnapshot, subscribeAgentSession } from '../../../hooks/agent-stream/session-stream-store.js';
import { MessageQueue, type QueueDeliver, type QueueSnapshot } from './message-queue.js';
import { loadQueuedMessages, saveQueuedMessages } from './message-queue-storage.js';
export type { QueueMode, QueueDeliver, QueuedMessage } from './message-queue.js';

interface QueueEntry { queue: MessageQueue; unsubscribe: () => void; unwatch: () => void; observers: number }
const queues = new Map<string, QueueEntry>();
const deletedSessions = new Set<string>();
const EMPTY: QueueSnapshot = { items: [], paused: false, restoring: false };

function releaseIdleQueue(id: string): void {
  const entry = queues.get(id);
  if (!entry || entry.observers || entry.queue.getSnapshot().restoring || entry.queue.getSnapshot().items.length) return;
  entry.unwatch(); entry.unsubscribe(); queues.delete(id);
  entry.queue.dispose();
}

function ensureQueue(id: string, deliver: QueueDeliver): MessageQueue | undefined {
  if (deletedSessions.has(id)) return undefined;
  let entry = queues.get(id);
  if (!entry) {
    const queue = new MessageQueue({ deliver, state: getAgentSessionSnapshot(id), save: items => saveQueuedMessages(id, items) });
    entry = { queue, observers: 0, unwatch: () => undefined,
      unsubscribe: subscribeAgentSession(id, () => queue.setRunState(getAgentSessionSnapshot(id))) };
    queues.set(id, entry);
    void queue.restore(() => loadQueuedMessages(id));
    entry.unwatch = queue.subscribe(() => releaseIdleQueue(id));
  }
  entry.queue.deliver = deliver;
  return entry.queue;
}

export function forgetMessageQueue(sessionId: string): void {
  deletedSessions.add(sessionId);
  const entry = queues.get(sessionId);
  entry?.unwatch();
  entry?.unsubscribe();
  entry?.queue.dispose();
  queues.delete(sessionId);
  if (!entry) void saveQueuedMessages(sessionId, []).catch(() => undefined);
}

export function useMessageQueue(opts: { sessionId: string | null; deliver: QueueDeliver }) {
  const { sessionId, deliver } = opts;
  useEffect(() => { if (sessionId) ensureQueue(sessionId, deliver); }, [sessionId, deliver]);
  const subscribe = useCallback((listener: () => void) => {
    if (!sessionId) return () => undefined;
    const queue = ensureQueue(sessionId, deliver);
    const entry = queues.get(sessionId);
    if (!queue || !entry) return () => undefined;
    entry.observers++;
    const unsubscribe = queue.subscribe(listener);
    return () => { unsubscribe(); entry.observers--; releaseIdleQueue(sessionId); };
  }, [sessionId, deliver]);
  const snapshot = useSyncExternalStore(subscribe, () => sessionId ? queues.get(sessionId)?.queue.getSnapshot() ?? EMPTY : EMPTY, () => EMPTY);
  const get = useCallback(() => sessionId ? ensureQueue(sessionId, deliver) : undefined, [sessionId, deliver]);
  const enqueue = useCallback((...args: Parameters<MessageQueue['enqueue']>) => get()?.enqueue(...args) ?? false, [get]);
  const promote = useCallback((id: string) => get()?.promote(id), [get]);
  const remove = useCallback((id: string) => get()?.remove(id), [get]);
  const pause = useCallback(() => get()?.pause(), [get]);
  const resume = useCallback(() => get()?.resume(), [get]);
  return { ...snapshot, enqueue, promote, remove, pause, resume };
}
