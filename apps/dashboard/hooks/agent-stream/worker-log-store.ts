/**
 * Dedicated store for the per-session worker event log, deliberately kept
 * OUT of `SessionState`/`useAgentStream`. The SSE stream can emit large bursts;
 * routing diagnostic entries through session state re-rendered the whole `AgentChat`
 * tree on every event — even with the Worker Log panel closed. Here only the
 * panel (when mounted) subscribes, and commits are coalesced per animation
 * frame, so ingestion remains bounded when nobody is watching.
 *
 * Writer side (openStream) calls `pushWorkerLog`; the buffer is drained into
 * the zustand store at most once per frame. The throttle lives on the writer,
 * not the subscription, so there is no StrictMode subscribe/unsubscribe timer
 * hazard.
 */
import { create } from 'zustand';
import type { WorkerLogEntry } from './types.js';
import { MAX_SESSIONS } from './prune-sessions.js';

/** LIFO cap per session — mirrors the old `SessionState.eventLog` bound. */
const CAP = 1000;
const EMPTY: readonly WorkerLogEntry[] = [];

interface WorkerLogStore {
  /** Per-session committed entries. A new array reference per sid on change
   *  drives selector re-renders only for that session's subscriber. */
  slots: Map<number, readonly WorkerLogEntry[]>;
  _set: (slots: Map<number, readonly WorkerLogEntry[]>) => void;
}

const useWorkerLogStore = create<WorkerLogStore>((set) => ({
  slots: new Map(),
  _set: (slots) => set({ slots }),
}));

// --- Writer-side coalescing (module-level, not React state) ----------------
const pending = new Map<number, WorkerLogEntry[]>();
// Monotonic touch counter for LRU eviction of idle slots.
let touchSeq = 0;
const touched = new Map<number, number>();

// --- Per-sid seq dedup (module-level, survives remounts) -------------------
// The SSE layer can legitimately re-deliver events the panel already has:
// reconnect replays (`subscribe(since)` re-sends the buffer tail), full
// replays after a remount (reattach with since=-1), and zombie streams from
// unmounted hook instances. Bus seq restarts at 0 per run, so a bare seq
// high-water mark would drop a new run's events — the mark is paired with
// the bus id announced by the server's `bus_info` preamble and reset when
// the bus changes.
const dedup = new Map<number, { busKey: string | null; hwm: number }>();

/** Record which bus is serving `sid`. Returns true when it changed (hwm reset). */
export function noteWorkerLogBus(sid: number, busKey: string): boolean {
  const d = dedup.get(sid);
  if (d && d.busKey === busKey) return false;
  dedup.set(sid, { busKey, hwm: -1 });
  return true;
}
let rafHandle: number | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

function commitPending(): void {
  rafHandle = null;
  if (timeoutHandle !== null) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  if (pending.size === 0) return;
  const { slots } = useWorkerLogStore.getState();
  const next = new Map(slots);
  for (const [sid, incoming] of pending) {
    const cur = next.get(sid) ?? EMPTY;
    let merged = cur.length === 0 ? incoming.slice() : cur.concat(incoming);
    if (merged.length > CAP) merged = merged.slice(merged.length - CAP);
    next.set(sid, merged);
  }
  pending.clear();
  evictIdle(next);
  useWorkerLogStore.getState()._set(next);
}

/** Bound the store independently of React: keep the most-recently-touched
 *  `MAX_SESSIONS` slots so a long work session opening many chats can't leak. */
function evictIdle(slots: Map<number, readonly WorkerLogEntry[]>): void {
  if (slots.size <= MAX_SESSIONS) return;
  const byAge = [...slots.keys()].sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
  for (const sid of byAge.slice(0, slots.size - MAX_SESSIONS)) {
    slots.delete(sid);
    touched.delete(sid);
    dedup.delete(sid);
  }
}

function schedule(): void {
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(commitPending);
  // Fallback for background tabs / suspended rAF (mirrors openStream's flush).
  timeoutHandle = setTimeout(() => {
    timeoutHandle = null;
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      commitPending();
    }
  }, 120);
}

/** Append one event for a session. Coalesced — safe to call 50+/s.
 *  `seq` is the SSE event id (bus seq); duplicates at or below the current
 *  high-water mark for the sid's bus are dropped. Entries without a seq are
 *  always accepted. */
export function pushWorkerLog(sid: number, entry: WorkerLogEntry, seq?: number): void {
  if (seq !== undefined) {
    const d = dedup.get(sid);
    if (d) {
      if (seq <= d.hwm) return;
      d.hwm = seq;
    } else {
      // Stream without a bus_info preamble (defensive) — still monotonic.
      dedup.set(sid, { busKey: null, hwm: seq });
    }
  }
  let buf = pending.get(sid);
  if (!buf) {
    buf = [];
    pending.set(sid, buf);
  }
  buf.push(entry);
  touched.set(sid, ++touchSeq);
  schedule();
}

/** Test-only: reset all module-level writer state and committed slots. */
export function __resetWorkerLogForTests(): void {
  pending.clear();
  touched.clear();
  dedup.clear();
  touchSeq = 0;
  if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  if (timeoutHandle !== null) { clearTimeout(timeoutHandle); timeoutHandle = null; }
  useWorkerLogStore.getState()._set(new Map());
}

/** Subscribe to one session's entries. Only re-renders this subscriber when
 *  that session's array changes (coalesced ~1/frame). */
export function useWorkerLog(sid: number | null): readonly WorkerLogEntry[] {
  return useWorkerLogStore((s) => (sid == null ? EMPTY : s.slots.get(sid) ?? EMPTY));
}

/** Non-reactive snapshot of one session's committed entries (tests/debug). */
export function peekWorkerLog(sid: number): readonly WorkerLogEntry[] {
  return useWorkerLogStore.getState().slots.get(sid) ?? EMPTY;
}
