import { raceWithAbort } from './invoke-lifecycle.js';

/** A closed observation port ends its subscription, never a terminal/run. */
export async function pumpMessagePortStream(
  port: Electron.MessagePortMain,
  create: () => AsyncIterable<unknown>,
  controller: AbortController,
  serializeError: (error: unknown) => unknown,
): Promise<void> {
  const { signal } = controller;
  const onClose = () => controller.abort(new Error('stream subscriber closed'));
  port.on('close', onClose);
  let iterator: AsyncIterator<unknown> | undefined;
  let completed = false;
  try {
    if (signal.aborted) return;
    iterator = create()[Symbol.asyncIterator]();
    port.start();
    while (!signal.aborted) {
      const step = await raceWithAbort(signal, () => iterator!.next());
      if (signal.aborted) break;
      if (step.done) { completed = true; break; }
      port.postMessage({ type: 'value', value: step.value });
    }
    if (!signal.aborted) port.postMessage({ type: 'done' });
  } catch (error) {
    if (!signal.aborted) {
      try { port.postMessage({ type: 'error', error: serializeError(error) }); } catch { /* peer closed */ }
    }
  } finally {
    port.removeListener('close', onClose);
    if (!completed && iterator?.return) {
      // An async generator may still be awaiting an uncooperative producer.
      // Do not make transport disposal depend on that producer completing.
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* already closed */ }
    }
    try { port.close(); } catch { /* peer already destroyed */ }
  }
}
