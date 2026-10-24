import type { MessageBridge } from '@mcp/orchestrator-host';
import { getGlobalPreviewDevtools, type PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import { previewDispatchArguments } from '@mcp/code-agent/tools/preview/authority.js';
import type { WorkerApplicationOwnerResolver } from './worker-application-owner.js';

export function registerWorkerPreviewCalls(bridge: MessageBridge,
  getOwner: WorkerApplicationOwnerResolver): () => void {
  const calls = new Map<string, AbortController>();
  let closed = false;
  const offCall = bridge.handle('previewDevtools', async payload => {
    const request = payload as PreviewInvoke;
    const backend = getGlobalPreviewDevtools();
    if (!backend || closed) throw new Error('Preview DevTools unavailable');
    if (typeof request?.requestId !== 'string' || request.requestId.length > 256
      || calls.has(request.requestId) || calls.size >= 32) throw new Error('Invalid or saturated preview request');
    const controller = new AbortController();
    calls.set(request.requestId, controller);
    try {
      const owner = await getOwner(request.runId);
      owner.assertOwner();
      controller.signal.throwIfAborted();
      if (closed) throw new Error('Preview worker scope closed');
      if (request.authority || request.key !== `coder-${owner.sessionId}`) throw new Error('Preview request has a foreign owner');
      // Also excludes backend-only close-prefix and thumbnail methods.
      previewDispatchArguments(request.method, request.args ?? {}, owner.projectId);
      return await backend.invoke(request, { assertDispatch: owner.assertOwner,
        signal: AbortSignal.any([owner.signal, controller.signal]) });
    } finally { calls.delete(request.requestId); }
  });
  const offCancel = bridge.handle('previewDevtoolsCancel', payload => {
    const id = (payload as { requestId?: string })?.requestId;
    if (id) calls.get(id)?.abort(new Error('Preview caller cancelled'));
    return { ok: true };
  });
  return () => {
    closed = true; offCall(); offCancel();
    for (const controller of calls.values()) controller.abort(new Error('Preview worker bridge closed'));
  };
}
