import { invalidateSessionLists } from './api-cache.js';

// The session stream, the app-wide stream and reconnect replay can all carry the same creation.
const seen = new Set<string>();

export function announceChatSessionCreated(childId: unknown): void {
  if (typeof childId !== 'string' || !childId || seen.has(childId)) return;
  seen.add(childId);
  if (seen.size > 256) seen.delete(seen.values().next().value!);
  invalidateSessionLists();
  window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
}
