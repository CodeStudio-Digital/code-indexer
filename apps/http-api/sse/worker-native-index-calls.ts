import { createHash } from 'node:crypto';
import type { MessageBridge } from '@mcp/orchestrator-host';
import { authorizeNativeApplicationDispatch, type NativeApplicationRequest } from '../native-application-dispatch.js';
import type { OwnedProjectIndexService } from '../server/owned-project-index.js';
import { nativeApplicationTarget, NativeAttemptDrainFence, type WorkerApplicationOwnerResolver } from './native-application-owner.js';
import type { WorkerPreviewOwner } from './worker-preview-calls.js';

type Request = NativeApplicationRequest & { requestId: string; runId: number };
type Call = { digest: string; key: string; controller: AbortController; done: Promise<string>; settled: boolean };

/** Retain both success and failure receipts until drain. A lost ACK never
 * authorizes another structural pass or semantic rebuild. */
export function registerWorkerNativeIndexCalls(bridge: MessageBridge,
  getOwner: WorkerApplicationOwnerResolver,
  getService: () => OwnedProjectIndexService | null | undefined): () => void {
  const calls = new Map<string, Call>();
  const drainingAttempts = new NativeAttemptDrainFence(); let closed = false;
  const off = bridge.handle('nativeIndexReconcile', async payload => {
    const request = payload as Request;
    if (closed || typeof request?.requestId !== 'string' || !request.requestId || request.requestId.length > 256
      || request.requestId !== request.authority?.toolUseId || JSON.stringify(request).length > 64 * 1024
      || typeof request.key !== 'string' || !request.key || request.key.length > 256) throw new Error('Invalid native indexing request');
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const callId = `${request.key}:${request.requestId}`;
    const previous = calls.get(callId);
    if (previous) {
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request)); owner.assertOwner();
      if (!owner.config || request.key !== `coder-${owner.sessionId}-attempt-${owner.config.context.attemptId}`) throw new Error('Native indexing receipt has a foreign attempt');
      drainingAttempts.assertOpen(request.runId, owner.config.context.attemptId);
      if (previous.digest !== digest) throw new Error('Native indexing operation ID has changed input');
      return previous.done;
    }
    if (calls.size >= 128 || [...calls.values()].some(call => !call.settled)) throw new Error('Native indexing receipt budget exhausted or operation pending');
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(190_000);
    let admittedOwner: WorkerPreviewOwner | undefined;
    const done = Promise.resolve().then(async () => {
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request)); owner.assertOwner();
      admittedOwner = owner;
      if (!owner.config || !owner.store || !owner.projectId || owner.projectId <= 0) throw new Error('Native indexing has no project attempt authority');
      const attemptId = owner.config.context.attemptId;
      if (closed) throw new Error('Native indexing bridge closed');
      drainingAttempts.assertOpen(request.runId, attemptId);
      const signal = AbortSignal.any([owner.signal, controller.signal, deadline]); signal.throwIfAborted();
      const name = request.authority?.toolName;
      if (name !== 'mcp__index_project') throw new Error('Unknown native indexing mutation');
      const auth = await authorizeNativeApplicationDispatch(request, owner.config!, {
        name, key: `coder-${owner.sessionId}-attempt-${attemptId}`, operation: 'index/reconcile', args: {},
      }, owner.store!, owner.assertOwner);
      const assertCurrent = () => { signal.throwIfAborted(); auth.assertDispatch(); };
      assertCurrent();
      const service = getService(); if (!service) throw new Error('Native indexing owner unavailable');
      const result = await service.reconcile(owner.projectId!, request.authority!.input, { signal, assertCurrent });
      assertCurrent();
      if (Buffer.byteLength(result) > 8192) throw new Error('Native indexing response exceeds budget');
      return result;
    });
    const call = { digest, key: request.key, controller, done, settled: false }; calls.set(callId, call);
    const timer = setInterval(() => { try { admittedOwner?.assertOwner(); } catch (e) { controller.abort(e); } }, 100); timer.unref();
    void done.finally(() => { call.settled = true; clearInterval(timer); }).catch(() => undefined);
    return done;
  });
  const offCancel = bridge.handle('nativeIndexCancel', async payload => {
    const request = payload as { requestId?: string; runId?: unknown };
    const owner = await getOwner(request?.runId, true, nativeApplicationTarget(request)); const call = calls.get(`coder-${owner.sessionId}-attempt-${owner.config?.context.attemptId}:${request?.requestId ?? ''}`);
    if (call) { call.controller.abort(new Error('Native indexing caller cancelled')); await call.done.catch(() => undefined); }
    return { closed: true };
  });
  const offDrain = bridge.handle('nativeIndexDrain', async payload => {
    const request = payload as { runId?: unknown; attemptId?: string };
    const owner = await getOwner(request?.runId, true, nativeApplicationTarget(request));
    if (!owner.config || owner.config.context.attemptId !== request.attemptId) throw new Error('Native indexing drain has a foreign attempt');
    drainingAttempts.begin(request.runId, request.attemptId);
    const owned = [...calls].filter(([, call]) => call.key === `coder-${owner.sessionId}-attempt-${request.attemptId}`);
    for (const [, call] of owned) call.controller.abort(new Error('Native indexing attempt closed'));
    await Promise.allSettled(owned.map(([, call]) => call.done));
    for (const [id] of owned) calls.delete(id);
    return { closed: true };
  });
  return () => { closed = true; off(); offCancel(); offDrain(); for (const call of calls.values()) call.controller.abort(new Error('Native indexing bridge closed')); };
}
