import { useRef } from 'react';

/**
 * Latch that flips true the first time `open` is true and never goes back.
 *
 * Lets a rarely-used dialog live in its own async chunk without changing how it
 * behaves. Gating the render on `open` alone would work for the download, but it
 * would also unmount the dialog the instant it closes — skipping Radix's exit
 * animation and discarding any in-progress form state. With the latch the chunk
 * is fetched on the first open and the component stays mounted afterwards,
 * exactly as a static import behaved.
 */
export function useOpenedOnce(open: boolean): boolean {
  const opened = useRef(false);
  if (open) opened.current = true;
  return opened.current;
}
