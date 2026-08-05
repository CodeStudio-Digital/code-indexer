import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';

export type AdapterPhase =
  'ready' | 'opening' | 'binding' | 'hydrating' | 'hydrated' | 'failed';

export function assertDataAdapterPhase(
  actual: AdapterPhase,
  expected: AdapterPhase,
): void {
  if (actual === expected) return;
  if (expected === 'ready') throw new AttemptControlAdapterError(
    'already_opened',
    'shadow attempt data adapter is single-use',
  );
  throw new AttemptControlAdapterError(
    'aborted',
    'shadow attempt data adapter lost channel ownership',
  );
}
