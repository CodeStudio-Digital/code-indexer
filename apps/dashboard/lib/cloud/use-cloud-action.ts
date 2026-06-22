/** Tiny helper for one-shot cloud actions: tracks busy/error and runs a thunk,
 *  surfacing a `CloudError`'s message. Keeps each section component terse. */
import { useCallback, useState } from 'react';
import { CloudError } from './cloud-errors.js';

export function useCloudAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof CloudError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run, setError };
}
