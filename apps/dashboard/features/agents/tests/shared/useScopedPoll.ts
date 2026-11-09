import { useCallback, useEffect, useRef, useState } from 'react';
import { useSurfaceVisible } from '../../../../lib/surface-visibility.js';
import { startScopedPoll } from './scoped-poll.js';

/** One in-flight read per scope. Old requests cannot update another session. */
export function useScopedPoll<T>(scope: string, read: (signal: AbortSignal) => Promise<T>, delay: (value: T | null) => number) {
  const visible = useSurfaceVisible();
  const [state, setState] = useState<{ scope: string; value: T | null; loading: boolean; error: string | null }>({ scope, value: null, loading: true, error: null });
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (!visible) return;
    const poll = startScopedPoll(read, (value, error) => setState({ scope, value, loading: false, error }), delay);
    refreshRef.current = poll.refresh;
    return poll.dispose;
  }, [scope, read, delay, visible]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...(state.scope === scope ? state : { scope, value: null, loading: true, error: null }), refresh };
}
