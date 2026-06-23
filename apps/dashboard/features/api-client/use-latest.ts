import { useRef } from 'react';

/**
 * Keep a ref pointing at the latest value (callback/prop) on every render.
 * Used to call the current handler from a listener registered once (e.g. a
 * Monaco onMount blur listener), avoiding stale-closure data loss.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
