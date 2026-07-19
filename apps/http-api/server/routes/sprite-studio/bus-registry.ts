/**
 * One long-lived event bus per sprite project (plan §2.5). Unlike coder buses
 * (one per run, markEnded on finish), these persist while the /sprites tab is
 * open so job events survive across individual job lifecycles. A bus is never
 * markEnded — the SSE pump's `waitEnded(bus, clientSignal)` resolves only when
 * the client disconnects. An idle sweep drops buses with no subscribers and no
 * recent activity so long-running servers don't leak.
 */
import { createBus, markEnded, publish, type CoderRunBus } from '../../../coder-bus.js';
import type { SpriteJobEvent } from '@mcp/sprite-studio/jobs/events.js';

const IDLE_MS = 10 * 60 * 1000; // 10 min with no subscribers/activity → evict

interface Entry {
  bus: CoderRunBus;
  lastActivity: number;
}

const buses = new Map<number, Entry>();

/** Get (or lazily create) the bus for a sprite project's DB id. */
export function getSpriteBus(spriteProjectId: number): CoderRunBus {
  let entry = buses.get(spriteProjectId);
  if (!entry) {
    // The AbortController is unused (we never markEnded), but createBus needs it.
    entry = { bus: createBus(new AbortController()), lastActivity: Date.now() };
    buses.set(spriteProjectId, entry);
  }
  entry.lastActivity = Date.now();
  return entry.bus;
}

/** Publish a typed sprite-job event onto a project's bus (SSE event name = type). */
export function emitSpriteEvent(spriteProjectId: number, ev: SpriteJobEvent): void {
  const bus = getSpriteBus(spriteProjectId);
  publish(bus, ev.type, ev);
  const entry = buses.get(spriteProjectId);
  if (entry) entry.lastActivity = Date.now();
}

/** Sweep idle buses (no subscribers, no recent activity). Called on a timer. */
export function sweepIdleSpriteBuses(now = Date.now()): void {
  for (const [id, entry] of buses) {
    if (entry.bus.subscribers.size === 0 && now - entry.lastActivity > IDLE_MS) {
      buses.delete(id);
    }
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the idle sweep (idempotent). Called once when the routes mount. */
export function startSpriteBusSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepIdleSpriteBuses(), IDLE_MS);
  sweepTimer.unref?.();
}

/** Stop the process-wide sweep and release all SSE bus state on app shutdown. */
export function stopSpriteBusSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  for (const entry of buses.values()) {
    entry.bus.ctrl.abort('app-shutdown');
    if (!entry.bus.ended) markEnded(entry.bus, 'error', { error: 'app_shutdown' });
    entry.bus.subscribers.clear();
    entry.bus.buffer.length = 0;
  }
  buses.clear();
}
