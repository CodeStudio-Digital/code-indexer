/**
 * Client-side prefix-forward cache for ghost text: when the user types
 * forward THROUGH the completion currently/last shown, serve the remainder
 * instantly — no debounce, no RPC, no spinner. Mirrors the server-side
 * forward cache but saves the round-trip entirely. Keeps the ORIGINAL
 * requestId so accept telemetry still correlates.
 */

interface Slot {
  line: number;
  col: number;
  text: string;
  requestId?: string;
  at: number;
}

const TTL_MS = 30_000;
const MAX_FILES = 8;

// Module-level: one slot per (project:file), tiny FIFO.
const slots = new Map<string, Slot>();

export function recordShownCompletion(
  key: string, line: number, col: number, text: string, requestId?: string,
): void {
  if (slots.has(key)) slots.delete(key);
  slots.set(key, { line, col, text, requestId, at: Date.now() });
  if (slots.size > MAX_FILES) {
    const oldest = slots.keys().next().value;
    if (oldest !== undefined) slots.delete(oldest);
  }
}

/**
 * Forward hit when the buffer text between the recorded column and the
 * current cursor (fetched lazily via `getTypedSince`, since only this module
 * knows the recorded column) matches the completion's head.
 */
export function tryForwardCompletion(
  key: string, line: number, col: number,
  getTypedSince: (fromCol: number) => string,
): { text: string; requestId?: string } | null {
  const slot = slots.get(key);
  if (!slot) return null;
  if (Date.now() - slot.at > TTL_MS) { slots.delete(key); return null; }
  if (slot.line !== line || col <= slot.col) return null;
  const delta = col - slot.col;
  if (delta >= slot.text.length) return null;
  const typedText = getTypedSince(slot.col);
  if (typedText.length !== delta || !slot.text.startsWith(typedText)) return null;
  return { text: slot.text.slice(delta), requestId: slot.requestId };
}

export function invalidateForwardCompletion(key: string): void {
  slots.delete(key);
}

/** Test hook. */
export function __resetForwardCacheForTests(): void {
  slots.clear();
}
