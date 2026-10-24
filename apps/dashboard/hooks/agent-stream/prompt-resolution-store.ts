/**
 * Answers the user already gave to interactive prompt cards, plus their
 * in-progress drafts, kept outside React.
 *
 * Two problems this solves:
 *
 * 1. The transcript is virtualized, so scrolling a card out of view UNMOUNTS it.
 *    A card whose `resolved` state lived in `useState` came back showing its
 *    buttons again, and a half-filled decision wizard lost its selections.
 * 2. There is a window between the click and the `tool_result` becoming visible
 *    to a refetch. During it the persisted copy still renders as pending.
 *
 * Live cards and persisted cards carry DIFFERENT ids for the same prompt (a
 * runtime `q_…` versus a provider `toolu_…`), so entries are indexed under both
 * the id and the content signature — the same signature the live⇄persisted
 * reconciliation uses to bridge the two sides.
 *
 * Module-level store + listener set, the pattern of `composer-draft-store.ts`.
 */

/** Whatever the widget renders as its answered state (string, verdict, map…). */
export type PromptResolution = unknown;

interface ResolutionInput {
  id: string;
  /** Content signature, so the persisted copy of this prompt matches too. */
  signature?: string;
  sessionId?: string;
  resolution: PromptResolution;
}

/** Keeps a long session from growing an unbounded answer log. */
const MAX_ENTRIES = 200;

const resolutions = new Map<string, PromptResolution>();
const drafts = new Map<string, unknown>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function evictOldest(map: Map<string, unknown>): void {
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function idKey(id: string): string {
  return `id:${id}`;
}

function signatureKey(signature: string, sessionId?: string): string {
  return `sig:${sessionId ?? '*'}:${signature}`;
}

/**
 * Record the user's answer. Indexed under the prompt id AND its signature so the
 * persisted rendering of the same prompt — which has a different id — finds it.
 */
export function markPromptResolved({ id, signature, sessionId, resolution }: ResolutionInput): void {
  if (resolution === undefined) return;
  resolutions.set(idKey(id), resolution);
  if (signature) {
    resolutions.set(signatureKey(signature, sessionId), resolution);
    // Session-agnostic fallback: the persisted card may render before the
    // session id is threaded through every call site.
    resolutions.set(signatureKey(signature), resolution);
  }
  evictOldest(resolutions);
  clearPromptDraft(id);
  notify();
}

/**
 * Undo an optimistic resolution. A transport failure means the verdict was never
 * acknowledged, so the card must offer its controls again rather than show a
 * false outcome.
 */
export function clearPromptResolution(id: string, signature?: string, sessionId?: string): void {
  resolutions.delete(idKey(id));
  if (signature) {
    resolutions.delete(signatureKey(signature, sessionId));
    resolutions.delete(signatureKey(signature));
  }
  notify();
}

export function getPromptResolution(
  id: string,
  signature?: string,
  sessionId?: string,
): PromptResolution | undefined {
  const byId = resolutions.get(idKey(id));
  if (byId !== undefined) return byId;
  if (!signature) return undefined;
  return resolutions.get(signatureKey(signature, sessionId))
    ?? resolutions.get(signatureKey(signature));
}

/**
 * Whether this prompt was answered in this renderer. The live event handlers use
 * it to decide if a card may be swept: an UNANSWERED prompt swept away leaves
 * nothing on screen, because the persisted checkpoint that would replace it is
 * written asynchronously and may not exist yet.
 */
export function isPromptResolved(id: string, signature?: string): boolean {
  return getPromptResolution(id, signature) !== undefined;
}

export function getPromptDraft<T>(id: string): T | undefined {
  return drafts.get(idKey(id)) as T | undefined;
}

/** Mirror of a widget's in-progress input, so a remount can restore it. */
export function setPromptDraft(id: string, value: unknown): void {
  if (value === undefined) {
    drafts.delete(idKey(id));
    return;
  }
  drafts.set(idKey(id), value);
  evictOldest(drafts);
}

function clearPromptDraft(id: string): void {
  drafts.delete(idKey(id));
}

export function subscribePromptResolutions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — the module state outlives individual test cases otherwise. */
export function resetPromptResolutions(): void {
  resolutions.clear();
  drafts.clear();
  listeners.clear();
}
