import type { WebContents } from 'electron';

/** Hash/history routing keeps the renderer alive, including its IPC streams. */
export function bindRendererLifetime(sender: WebContents, onEnd: (reason: string) => void): void {
  sender.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
    const mainFrame = details.isMainFrame ?? isMainFrame;
    const sameDocument = details.isSameDocument ?? isInPlace;
    if (mainFrame && !sameDocument) onEnd('renderer navigated');
  });
  sender.once('render-process-gone', () => onEnd('renderer process exited'));
  sender.once('destroyed', () => onEnd('renderer closed'));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('renderer request aborted');
}

/**
 * Settle the IPC-facing promise as soon as its renderer lifetime ends, even
 * when a legacy handler does not yet consume AbortSignal. The underlying work
 * may finish in the background, but Electron can release its PromiseHandle and
 * the old renderer realm immediately.
 */
export async function raceWithAbort<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
