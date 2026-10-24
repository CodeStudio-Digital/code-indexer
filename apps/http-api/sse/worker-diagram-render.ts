import type { MessageBridge } from '@mcp/orchestrator-host';
import { getDiagramRenderer, type DiagramRenderRequest } from '@mcp/code-agent/tools/diagram/render-port.js';
import { nativeApplicationTarget, type WorkerApplicationOwnerResolver } from './native-application-owner.js';
import type { WorkerPreviewOwner } from './worker-preview-calls.js';

/** Rendering has no project effects. Physical image creation remains in the
 * worker's fenced filesystem port after the renderer returns and closes. */
export function registerWorkerDiagramRender(bridge: MessageBridge, getOwner: WorkerApplicationOwnerResolver): () => void {
  const calls = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  let closed = false;
  const off = bridge.handle('diagramRender', async payload => {
    const request = payload as DiagramRenderRequest & { runId: unknown };
    const backend = getDiagramRenderer();
    if (closed || !backend || typeof request?.requestId !== 'string' || request.requestId.length > 128 || calls.has(request.requestId) || calls.size >= 2) throw new Error('Diagram renderer unavailable or saturated');
    const controller = new AbortController();
    let admittedOwner: WorkerPreviewOwner | undefined;
    const timer = setInterval(() => { try { admittedOwner?.assertOwner(); } catch (error) { controller.abort(error); } }, 100);
    timer.unref();
    const done = Promise.resolve().then(async () => {
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request)); owner.assertOwner();
      admittedOwner = owner;
      if (closed) throw new Error('Diagram worker closed');
      const signal = AbortSignal.any([owner.signal, controller.signal]); signal.throwIfAborted();
      const image = await backend.render(request, signal);
      owner.assertOwner(); signal.throwIfAborted(); return image;
    });
    calls.set(request.requestId, { controller, done });
    try { return await done; }
    finally { clearInterval(timer); calls.delete(request.requestId); }
  });
  const offCancel = bridge.handle('diagramRenderCancel', async payload => {
    const id = (payload as { requestId?: string })?.requestId, call = id && calls.get(id);
    if (call) { call.controller.abort(new Error('Diagram render caller cancelled')); await call.done.catch(() => undefined); }
    return { closed: true };
  });
  return () => { closed = true; off(); offCancel(); for (const call of calls.values()) call.controller.abort(new Error('Diagram worker closed')); };
}
