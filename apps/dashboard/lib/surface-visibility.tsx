import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

/** Visual work follows the retained pane; transports and durable stores do not. */
export const SurfaceVisibilityContext = createContext(true);

export function useSurfaceVisible(): boolean {
  return useContext(SurfaceVisibilityContext);
}

type Subscribe = (listener: () => void) => () => void;
const subscribeNever: Subscribe = () => () => undefined;

/** A hidden view holds one snapshot and owns no subscription. Reveal reads fresh. */
export function visibleStoreSource<T>(visible: boolean, subscribe: Subscribe, read: () => T) {
  if (visible) return { subscribe, read };
  const snapshot = read();
  return { subscribe: subscribeNever, read: () => snapshot };
}

export function useVisibleExternalStore<T>(subscribe: Subscribe, read: () => T): T {
  const visible = useSurfaceVisible();
  const source = useMemo(() => visibleStoreSource(visible, subscribe, read), [visible, subscribe, read]);
  return useSyncExternalStore(source.subscribe, source.read, source.read);
}
