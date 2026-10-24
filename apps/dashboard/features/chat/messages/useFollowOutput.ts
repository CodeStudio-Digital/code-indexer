import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Re-engaging demands the real bottom, not merely being near it. */
export const FOLLOW_RESUME_PX = 8;

/** Whether the view came back to the newest content and may follow again. */
export function shouldResumeFollow(distanceFromEnd: number): boolean {
  // Negative distances happen on elastic overscroll and count as the bottom.
  return distanceFromEnd <= FOLLOW_RESUME_PX;
}

/**
 * Whether a pointer went down on the vertical scrollbar rather than on content.
 * `contentRight` is the right edge of the content box, so anything past it is
 * the scrollbar gutter.
 */
export function isScrollbarPointer(clientX: number, contentRight: number): boolean {
  return clientX > contentRight;
}

function distanceFromEnd(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight - el.scrollTop;
}

interface FollowOutputOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Changing this re-engages follow and pins to the end (session switch). */
  resetKey?: string | null;
}

interface FollowOutput {
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
 *
 * Disengaging is driven by INTENT (wheel, touch, scrollbar grab, keys), never by
 * how far the view has travelled. A distance threshold cannot work here: the pin
 * runs on every commit and returns the view to the bottom between wheel ticks, so
 * the distance is erased before it can ever cross the threshold and the user is
 * trapped at the end of the transcript. Position is consulted only to decide when
 * following may RESUME.
 */
export function useFollowOutput({ scrollRef, resetKey }: FollowOutputOptions): FollowOutput {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const resumeIntent = useRef(false);
  const setFollow = useCallback((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !followingRef.current) return;
    const target = el.scrollHeight - el.clientHeight;
    if (target <= el.scrollTop) return;
    el.scrollTop = target;
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const release = () => { resumeIntent.current = false; setFollow(false); };
    let touchY = 0;
    let draggingScrollbar = false;
    let previousTop = el.scrollTop;

    // A wheel event fires BEFORE the scroll it causes, so the pin never gets a
    // chance to undo the gesture.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release();
      else if (event.deltaY > 0) resumeIntent.current = true;
    };
    // Any touch drag: a downward fling lands at the bottom and re-engages below.
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? touchY;
      release();
      resumeIntent.current = nextY < touchY;
      touchY = nextY;
    };
    // Dragging the scrollbar produces no wheel or touch event at all.
    const onPointerDown = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      if (isScrollbarPointer(event.clientX, rect.left + el.clientWidth)) {
        draggingScrollbar = true;
        previousTop = el.scrollTop;
        release();
      }
    };
    const onPointerUp = () => { draggingScrollbar = false; };
    // Capture: the transcript itself never holds focus, so these arrive from
    // whatever descendant the user is on.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') release();
      if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') resumeIntent.current = true;
    };
    const onScroll = () => {
      if (draggingScrollbar) resumeIntent.current = el.scrollTop > previousTop;
      previousTop = el.scrollTop;
      if (!followingRef.current && resumeIntent.current && shouldResumeFollow(distanceFromEnd(el))) {
        resumeIntent.current = false;
        setFollow(true);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    el.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('keydown', onKeyDown, true);
      el.removeEventListener('scroll', onScroll);
    };
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

  const disengage = useCallback(() => { resumeIntent.current = false; setFollow(false); }, [setFollow]);

  return { following, jumpToEnd, disengage };
}
