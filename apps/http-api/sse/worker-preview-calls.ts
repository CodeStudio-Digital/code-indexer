import type { MessageBridge } from '@mcp/orchestrator-host';
import { getGlobalPreviewDevtools, type PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import { nativePreviewKey, previewDispatchArguments } from '@mcp/code-agent/tools/preview/authority.js';
import type { NativeCoderDevelopmentConfig } from '../workers/native-coder-execution.js';
import type { NativeProductAuthority } from '../native-attempt-runtime.js';
import type { FileControlPlaneAuthority } from '../file-control-plane-store.js';
import { authorizeNativePreviewDispatch } from '../native-preview-dispatch.js';
import { NativePreviewAttempt } from '../native-preview-attempt.js';
import { nativeApplicationTarget, NativeAttemptDrainFence, type WorkerApplicationOwnerResolver } from './native-application-owner.js';

export interface WorkerPreviewOwner {
  sessionId: string | number;
  projectId: number | null;
  projectRoot?: string | null;
  config?: NativeCoderDevelopmentConfig;
  store?: (NativeProductAuthority & Pick<FileControlPlaneAuthority, 'assertNativeWorkspaceLease'>
    & Partial<Pick<FileControlPlaneAuthority, 'resolveNativeChildTranscript' | 'resolveSessionChildTranscript'>>) | null;
  signal: AbortSignal;
  assertOwner(): void;
}

export function registerWorkerPreviewCalls(bridge: MessageBridge,
  getOwner: WorkerApplicationOwnerResolver): () => void {
  const calls = new Map<string, AbortController>();
  const attempts = new Map<string, NativePreviewAttempt>();
  const draining = new NativeAttemptDrainFence();
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
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request));
      owner.assertOwner();
      if (owner.config) {
        draining.assertOpen(request.runId, owner.config.context.attemptId);
        if (!owner.store) throw new Error('Native preview authority unavailable');
        const authority = await authorizeNativePreviewDispatch(request, owner.config, owner.projectId, owner.store, owner.assertOwner);
        controller.signal.throwIfAborted();
        if (closed) throw new Error('Preview worker scope closed');
        draining.assertOpen(request.runId, owner.config.context.attemptId);
        let attempt = attempts.get(request.key);
        if (!attempt) {
          attempt = new NativePreviewAttempt(backend, request.key, owner.config, authority.lease, owner.projectId,
            owner.signal, authority.assertLifetime, owner.projectRoot);
          attempts.set(request.key, attempt);
        }
        return await attempt.invoke({ ...request, args: authority.args }, authority.assertDispatch, controller.signal);
      }
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
  const offClose = bridge.handle('previewDevtoolsDrain', async payload => {
    const request = payload as { runId?: unknown; attemptId?: string };
    const owner = await getOwner(request?.runId, true, nativeApplicationTarget(request));
    if (!owner.config || request.attemptId !== owner.config.context.attemptId) throw new Error('Preview drain belongs to a different attempt');
    const key = nativePreviewKey(owner.sessionId, request.attemptId);
    draining.begin(request.runId, request.attemptId);
    await attempts.get(key)?.close();
    attempts.delete(key);
    return { closed: true };
  });
  return () => {
    closed = true; offCall(); offCancel(); offClose();
    for (const controller of calls.values()) controller.abort(new Error('Preview worker bridge closed'));
    for (const attempt of attempts.values()) void attempt.close().catch(() => undefined);
  };
}
