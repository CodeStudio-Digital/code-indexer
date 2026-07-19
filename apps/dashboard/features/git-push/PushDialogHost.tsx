import { lazy, Suspense } from 'react';
import { usePushDialogStore } from './push-dialog-store.js';

const PushDialog = lazy(() =>
  import('./PushDialog.js').then((module) => ({ default: module.PushDialog })),
);

/**
 * Keep the global subscription cheap. The review UI, diff parser, virtualizer,
 * and syntax highlighter are downloaded only after a push review is opened.
 */
export function PushDialogHost() {
  const request = usePushDialogStore((state) => state.request);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <PushDialog key={request.id} request={request} />
    </Suspense>
  );
}
