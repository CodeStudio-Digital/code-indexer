import { useEffect, useRef, useState } from 'react';

/**
 * Rate-limit how often a fast-changing value reaches an expensive renderer.
 *
 * Built for the streaming transcript. `openStream` already coalesces SSE tokens
 * to one flush per animation frame, but a frame is still ~16 ms — and each
 * flush hands react-markdown a slightly longer string, which re-parses the
 * ENTIRE accumulated message (micromark → mdast → hast → React elements) from
 * scratch. A 6 KB answer therefore gets fully re-parsed dozens of times per
 * second, and the same applies to Shiki re-highlighting a growing code fence.
 * `useDeferredValue` alone only makes that work interruptible; it does not make
 * it less work.
 *
 * The contract is chosen so nothing can be lost:
 *
 *  - The FIRST change commits immediately, so text starts appearing instantly.
 *  - Further changes commit at most once per `intervalMs`.
 *  - A trailing commit always runs, so the value converges on the final text
 *    even if the stream stops mid-window. The settled output is byte-identical
 *    to the unthrottled one — only the intermediate frames are skipped.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  // Refs, not state, so a queued trailing commit always publishes the NEWEST
  // value rather than the one captured when the timer was scheduled.
  const latestRef = useRef(value);
  const shownRef = useRef(value);
  const lastCommitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestRef.current = value;

  useEffect(() => {
    if (Object.is(shownRef.current, value)) return;

    const commit = () => {
      timerRef.current = null;
      lastCommitRef.current = Date.now();
      shownRef.current = latestRef.current;
      setShown(latestRef.current);
    };

    // `lastCommitRef` starts at 0, so the first change is always immediate.
    if (Date.now() - lastCommitRef.current >= intervalMs) {
      commit();
      return;
    }
    // A trailing commit is already queued — it will pick up this value too.
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(commit, intervalMs - (Date.now() - lastCommitRef.current));
  }, [value, intervalMs]);

  // Unmounting mid-window must not leave a timer holding the closure alive.
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  return shown;
}
