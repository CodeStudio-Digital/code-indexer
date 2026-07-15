import type * as MonacoNs from 'monaco-editor';

/** Run one API request under Monaco's cancellation token. */
export async function withMonacoCancellation<T>(
  token: MonacoNs.CancellationToken,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const subscription = token.onCancellationRequested(() => controller.abort());
  try {
    return await run(controller.signal);
  } finally {
    subscription.dispose();
  }
}

/** Resolve true if the token cancels during the coalescing window. */
export function cancelledWithin(ms: number, token: MonacoNs.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) return resolve(true);
    const timer = setTimeout(() => { subscription.dispose(); resolve(false); }, ms);
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(true);
    });
  });
}
