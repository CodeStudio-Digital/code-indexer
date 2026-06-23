/**
 * In-memory message queue for the chat composer. Lets the user compose and
 * enqueue follow-up messages WHILE the agent is streaming, with a per-message
 * delivery choice:
 *
 *   • 'next-turn'      — delivered immediately to the live run (enqueue-and-
 *                        attach on the backend; the runner drains it at the top
 *                        of its next turn). `interject` is set so it lands even
 *                        if the runner is blocked on an interactive tool.
 *   • 'end-of-session' — parked in the visible strip; delivered when the
 *                        current run finishes (streaming true→false). Its send
 *                        starts a fresh run, so the NEXT parked item waits for
 *                        THAT run to end — one per run, FIFO.
 *
 * The queue is renderer-owned and ephemeral (cleared on session switch); it
 * does not survive reload — matching how file picks behave.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type QueueMode = 'next-turn' | 'end-of-session';

export interface QueuedMessage {
  id: number;
  text: string;
  skillIds?: string[];
  mode: QueueMode;
  /** 'pending' = parked; 'sent' = handed to the live run (transient chip). */
  status: 'pending' | 'sent';
}

/**
 * Delivers a queued message through the surface's normal send path.
 * `interject` breaks an interactive wait so a next-turn message lands even
 * when the runner is blocked on submit_plan / ask_user.
 */
export type QueueDeliver = (
  text: string,
  opts: { interject: boolean; skillIds?: string[] },
) => void | Promise<void>;

/** How long a delivered next-turn confirmation chip lingers before clearing. */
const SENT_CHIP_TTL_MS = 2500;

export function useMessageQueue(opts: { streaming: boolean; deliver: QueueDeliver }) {
  const { streaming, deliver } = opts;
  const [items, setItems] = useState<QueuedMessage[]>([]);
  const idRef = useRef(0);
  const itemsRef = useRef<QueuedMessage[]>(items);
  const prevStreamingRef = useRef(streaming);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Mirror items so effects can read the latest set without depending on it.
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);

  const scheduleRemoval = useCallback((id: number) => {
    const handle = setTimeout(() => {
      timersRef.current.delete(handle);
      setItems((prev) => prev.filter((i) => i.id !== id));
    }, SENT_CHIP_TTL_MS);
    timersRef.current.add(handle);
  }, []);

  const fireNextTurn = useCallback((id: number, text: string, skillIds?: string[]) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'sent', mode: 'next-turn' } : i)));
    void Promise.resolve(deliver(text, { interject: true, skillIds })).catch(() => {});
    scheduleRemoval(id);
  }, [deliver, scheduleRemoval]);

  const enqueue = useCallback((text: string, mode: QueueMode, skillIds?: string[]) => {
    if (!text.trim()) return;
    const id = ++idRef.current;
    if (mode === 'next-turn') {
      setItems((prev) => [...prev, { id, text, skillIds, mode, status: 'sent' }]);
      void Promise.resolve(deliver(text, { interject: true, skillIds })).catch(() => {});
      scheduleRemoval(id);
    } else {
      setItems((prev) => [...prev, { id, text, skillIds, mode, status: 'pending' }]);
    }
  }, [deliver, scheduleRemoval]);

  /** Promote a parked end-of-session item to deliver right now (next turn). */
  const promote = useCallback((item: QueuedMessage) => {
    if (item.status !== 'pending') return;
    fireNextTurn(item.id, item.text, item.skillIds);
  }, [fireNextTurn]);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  // Drain one parked end-of-session item each time a run finishes (streaming
  // true→false). Reading via itemsRef keeps this off the `items` dependency,
  // so it fires only on the streaming transition — not on every queue edit.
  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (!was || streaming) return; // only the true→false edge
    const next = itemsRef.current.find((i) => i.mode === 'end-of-session' && i.status === 'pending');
    if (!next) return;
    setItems((prev) => prev.filter((i) => i.id !== next.id));
    void Promise.resolve(deliver(next.text, { interject: false, skillIds: next.skillIds })).catch(() => {});
  }, [streaming, deliver]);

  return { items, enqueue, promote, remove, clear };
}
