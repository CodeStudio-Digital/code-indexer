import { useCallback, useSyncExternalStore } from 'react';
import {
  getPromptDraft,
  getPromptResolution,
  subscribePromptResolutions,
  type PromptResolution,
} from './prompt-resolution-store.js';

/**
 * The answer this prompt already got, surviving the unmount that virtualization
 * causes when the card scrolls out of view. Values come from a Map, so their
 * identity is stable and `useSyncExternalStore` can cache the snapshot.
 */
export function usePromptResolution<T = PromptResolution>(
  id: string,
  signature?: string,
  sessionId?: string,
): T | undefined {
  const snapshot = useCallback(
    () => getPromptResolution(id, signature, sessionId) as T | undefined,
    [id, signature, sessionId],
  );
  return useSyncExternalStore(subscribePromptResolutions, snapshot, snapshot);
}

/**
 * Read a widget's saved draft once, for seeding local state on mount. Not
 * reactive on purpose: the widget owns the value while mounted and only needs
 * the store to survive its own unmount.
 */
function usePromptDraftSeed<T>(id: string): T | undefined {
  return getPromptDraft<T>(id);
}
