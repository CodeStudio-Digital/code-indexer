import { startPolling } from '../../../../hooks/polling-controller.js';

export function startScopedPoll<T>(
  read: (signal: AbortSignal) => Promise<T>,
  publish: (value: T | null, error: string | null) => void,
  delay: (value: T | null) => number,
  visibility: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
) {
  let cancelled = false;
  let pending = false;
  let value: T | null = null;
  let controller: AbortController | undefined;
  const refresh = async () => {
    if (cancelled || pending || visibility.visibilityState === 'hidden') return;
    pending = true;
    controller = new AbortController();
    try {
      const next = await read(controller.signal);
      if (cancelled) return;
      value = next;
      publish(value, null);
    } catch (error) {
      if (!cancelled) publish(value, error instanceof Error ? error.message : String(error));
    } finally { pending = false; }
  };
  const stop = startPolling(refresh, () => delay(value), true, visibility);
  return { refresh, dispose: () => { cancelled = true; controller?.abort(); stop(); } };
}
