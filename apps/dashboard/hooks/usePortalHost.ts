import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Publishes a DOM node for portal consumers without using a state dispatcher
 * as a callback ref.
 *
 * React 19 can replay callback refs while revealing a suspended subtree.
 * Passing setState directly as the ref schedules another render from
 * commitAttachRef on every replay. An object ref is inert during attachment;
 * the layout effect only publishes when the actual node identity changed.
 */
export function usePortalHost<T extends HTMLElement>() {
  const hostRef = useRef<T>(null);
  const publishedHostRef = useRef<T | null>(null);
  const [host, setHost] = useState<T | null>(null);

  useLayoutEffect(() => {
    const nextHost = hostRef.current;
    if (publishedHostRef.current === nextHost) return;

    publishedHostRef.current = nextHost;
    setHost(nextHost);
  });

  return [hostRef, host] as const;
}
