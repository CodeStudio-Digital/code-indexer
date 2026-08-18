import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Mirrors the virtualizer's `scrollEndThreshold` so both agree on "at the end". */
export const FOLLOW_THRESHOLD_PX = 80;
/** Re-engaging demands the real bottom, not merely being near it. */
export const FOLLOW_RESUME_PX = 8;

/**
 * Follow state is driven by scroll events alone. Content growth does not move
 * `scrollTop`, so it never fires a scroll event and can never disengage the
 * follow by itself — only a real user gesture (wheel, drag, keys, touch) can.
 *
 * The thresholds are asymmetric on purpose: without hysteresis a 40px nudge
 * upward stays "at the end" and the next streamed frame yanks the view back
 * down, which is the fight this hook exists to end. Negative distances happen
 * on elastic overscroll and count as the bottom.
 */
export function computeFollowTransition(distanceFromEnd: number, following: boolean): boolean {
  if (following) return distanceFromEnd <= FOLLOW_THRESHOLD_PX;
  return distanceFromEnd <= FOLLOW_RESUME_PX;
}

function distanceFromEnd(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight - el.scrollTop;
}

interface FollowOutputOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Changing this re-engages follow and pins to the end (session switch). */
  resetKey?: string | null;
}

export interface FollowOutput {
  /** True while the view is pinned to the newest content. */
  following: boolean;
  /** Re-engage follow and jump to the end (the floating affordance). */
  jumpToEnd: () => void;
  /** Release the pin for a deliberate programmatic scroll elsewhere. */
  disengage: () => void;
}

/**
 * Stick-to-bottom for the transcript.
 *
 * Deliberately does NOT use `virtualizer.scrollToEnd()`: that installs a
 * persistent scroll state whose reconcile loop re-targets on every scroll event
 * with no user-intent check, so a manual scroll during streaming gets overwritten
 * in the same frame. Writing `scrollTop` from a layout effect instead pins after
 * React committed the new spacer height, so the browser cannot clamp the write
 * against a stale scroll range.
 */
export function useFollowOutput({ scrollRef, resetKey }: FollowOutputOptions): FollowOutput {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const setFollow = useCallback((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (distanceFromEnd(el) > 0) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      setFollow(computeFollowTransition(distanceFromEnd(el), followingRef.current));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, setFollow]);

  // No dependency array: every commit that changed the transcript height gets a
  // chance to re-pin. Late measurements (syntax highlighting swaps, image decode,
  // tool cards expanding, and the live→persisted row swap at the end of a turn)
  // each land in their own commit and are covered here.
  useLayoutEffect(() => {
    if (followingRef.current) pin();
  });

  useEffect(() => {
    setFollow(true);
    const frame = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(frame);
  }, [pin, resetKey, setFollow]);

  const jumpToEnd = useCallback(() => {
    setFollow(true);
    pin();
    requestAnimationFrame(pin);
  }, [pin, setFollow]);

  const disengage = useCallback(() => setFollow(false), [setFollow]);

  return { following, jumpToEnd, disengage };
}
