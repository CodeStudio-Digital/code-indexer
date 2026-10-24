import type { MessageBridge } from '@mcp/orchestrator-host';
import type { ResearchBrowserInvoke } from '@mcp/shared/research-browser.js';
import { getGlobalResearchBrowser } from '@mcp/code-agent/tools/browser/bridge.js';
import { browserDispatchArguments, nativeBrowserKey } from '@mcp/code-agent/tools/browser/authority.js';
import { authorizeNativeApplicationDispatch, type NativeApplicationRequest } from '../native-application-dispatch.js';
import { NativeBrowserAttempt } from '../native-browser-attempt.js';
import { nativeApplicationTarget, NativeAttemptDrainFence, type WorkerApplicationOwnerResolver } from './native-application-owner.js';

export function registerWorkerBrowserCalls(bridge: MessageBridge,
  getOwner: WorkerApplicationOwnerResolver): () => void {
  const calls = new Map<string, AbortController>();
  const attempts = new Map<string, NativeBrowserAttempt>();
  const draining = new NativeAttemptDrainFence();
  let closed = false;
  const offCall = bridge.handle('researchBrowser', async payload => {
    const request = payload as ResearchBrowserInvoke;
    const backend = getGlobalResearchBrowser();
    if (!backend || closed) throw new Error('Research browser unavailable');
    if (typeof request?.requestId !== 'string' || request.requestId.length > 256
      || calls.has(request.requestId) || calls.size >= 32) throw new Error('Invalid or saturated research browser request');
    const controller = new AbortController(); calls.set(request.requestId, controller);
    try {
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request)); owner.assertOwner();
      if (owner.config) {
        const key = nativeBrowserKey(owner.sessionId, owner.config.context.attemptId);
        draining.assertOpen(request.runId, owner.config.context.attemptId);
        if (!owner.store) throw new Error('Research browser authority unavailable');
        const packet = request.authority as NativeApplicationRequest['authority'];
        const authority = await authorizeNativeApplicationDispatch({ key: request.key, authority: packet }, owner.config, {
          key, name: `browser_${request.method}`, operation: 'browser/dispatch',
          args: browserDispatchArguments(request.method, packet?.input ?? {}),
        }, owner.store, owner.assertOwner);
        controller.signal.throwIfAborted();
        if (closed) throw new Error('Research browser worker scope closed');
        draining.assertOpen(request.runId, owner.config.context.attemptId);
        let attempt = attempts.get(key);
        if (!attempt) {
          attempt = new NativeBrowserAttempt(backend, key, owner.signal, authority.assertLifetime);
          attempts.set(key, attempt);
        }
        return await attempt.invoke({ ...request, args: authority.args }, authority.assertDispatch, controller.signal);
      }
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
  const offDrain = bridge.handle('researchBrowserDrain', async payload => {
    const request = payload as { runId?: unknown; attemptId?: string };
    const owner = await getOwner(request?.runId, true, nativeApplicationTarget(request));
    if (!owner.config || request.attemptId !== owner.config.context.attemptId) throw new Error('Research browser drain belongs to another attempt');
    const key = nativeBrowserKey(owner.sessionId, request.attemptId); draining.begin(request.runId, request.attemptId);
    await attempts.get(key)?.close(); attempts.delete(key);
    return { closed: true };
  });
  return () => {
    closed = true; offCall(); offCancel(); offDrain();
    for (const controller of calls.values()) controller.abort(new Error('Research browser worker bridge closed'));
    for (const attempt of attempts.values()) void attempt.close().catch(() => undefined);
  };
}
