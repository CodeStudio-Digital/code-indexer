import { useEffect, useRef } from 'react';

/** Coalesce a burst of events. Further events cannot postpone a scheduled read. */
export function useCompanyRevisionRefresh(revision: number, loading: boolean, refresh: () => void) {
  const latest = useRef(revision);
  const handled = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, [refresh]);
  useEffect(() => {
    latest.current = revision;
    if (loading) {
      clearTimeout(timer.current);
      timer.current = undefined;
      return;
    }
    if (revision === handled.current || timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      handled.current = latest.current;
      refresh();
    }, 300);
  }, [revision, loading, refresh]);
}
