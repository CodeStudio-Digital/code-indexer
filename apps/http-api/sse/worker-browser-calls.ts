import type { MessageBridge } from '@mcp/orchestrator-host';
import type { ResearchBrowserInvoke } from '@mcp/shared/research-browser.js';
import { getGlobalResearchBrowser } from '@mcp/code-agent/tools/browser/bridge.js';
import { browserDispatchArguments } from '@mcp/code-agent/tools/browser/authority.js';
import type { WorkerApplicationOwnerResolver } from './worker-application-owner.js';

export function registerWorkerBrowserCalls(bridge: MessageBridge,
  getOwner: WorkerApplicationOwnerResolver): () => void {
  const calls = new Map<string, AbortController>();
  let closed = false;
  const offCall = bridge.handle('researchBrowser', async payload => {
    const request = payload as ResearchBrowserInvoke;
    const backend = getGlobalResearchBrowser();
    if (!backend || closed) throw new Error('Research browser unavailable');
    if (typeof request?.requestId !== 'string' || request.requestId.length > 256
      || calls.has(request.requestId) || calls.size >= 32) throw new Error('Invalid or saturated research browser request');
    const controller = new AbortController(); calls.set(request.requestId, controller);
    try {
      const owner = await getOwner(request.runId); owner.assertOwner();
      controller.signal.throwIfAborted();
      if (closed) throw new Error('Research browser worker scope closed');
      if (request.authority || request.key !== `coder-${owner.sessionId}`) throw new Error('Research browser request has a foreign owner');
      browserDispatchArguments(request.method, {}); // Reject backend-only prefix operations.
      return await backend.invoke(request, { assertDispatch: owner.assertOwner,
        signal: AbortSignal.any([owner.signal, controller.signal]) });
    } finally { calls.delete(request.requestId); }
  });
  const offCancel = bridge.handle('researchBrowserCancel', payload => {
    const id = (payload as { requestId?: string })?.requestId;
    if (id) calls.get(id)?.abort(new Error('Research browser caller cancelled'));
    return { ok: true };
  });
  return () => {
    closed = true; offCall(); offCancel();
    for (const controller of calls.values()) controller.abort(new Error('Research browser worker bridge closed'));
  };
}
