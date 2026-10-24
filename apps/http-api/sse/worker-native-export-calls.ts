import { createHash } from 'node:crypto';
import type { MessageBridge } from '@mcp/orchestrator-host';
import type { ExportService } from '@mcp/services/services/exporter.js';
import { authorizeNativeApplicationDispatch, type NativeApplicationRequest } from '../native-application-dispatch.js';
import { nativeApplicationTarget, NativeAttemptDrainFence, type WorkerApplicationOwnerResolver } from './native-application-owner.js';
import type { WorkerPreviewOwner } from './worker-preview-calls.js';

type Request = NativeApplicationRequest & { requestId: string; runId: number };
type Call = { digest: string; key: string; controller: AbortController; done: Promise<string>; bytes: number };

/** Publication receipts remain owned until drain; duplicate packets cannot
 * replace the file twice. Drain waits for the physical rename/cleanup to settle. */
export function registerWorkerNativeExportCalls(bridge: MessageBridge,
  getOwner: WorkerApplicationOwnerResolver,
  getService: () => Pick<ExportService, 'exportProject'> | null | undefined): () => void {
  const calls = new Map<string, Call>();
  let receiptBytes = 0;
  const drainingAttempts = new NativeAttemptDrainFence(); let closed = false;
  const off = bridge.handle('nativeExportPublish', async payload => {
    const request = payload as Request;
    if (closed || typeof request?.requestId !== 'string' || request.requestId.length > 256 || !request.requestId
      || request.requestId !== request.authority?.toolUseId
      || typeof request.key !== 'string' || !request.key || request.key.length > 256) throw new Error('Invalid native export request');
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const callId = `${request.key}:${request.requestId}`;
    const previous = calls.get(callId);
    if (previous) {
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request)); owner.assertOwner();
      if (!owner.config || request.key !== `coder-${owner.sessionId}-attempt-${owner.config.context.attemptId}`) throw new Error('Native export receipt has a foreign attempt');
      drainingAttempts.assertOpen(request.runId, owner.config.context.attemptId);
      if (previous.digest !== digest) throw new Error('Native export operation ID has changed input');
      return previous.done;
    }
    // A single export is capped at 32 MiB. Stop admission at 32 MiB retained;
    // the last in-flight result can bring the total to at most 64 MiB.
    if (calls.size >= 128 || receiptBytes >= 32 * 1024 * 1024
      || [...calls.values()].some(call => call.bytes < 0)) throw new Error('Native export receipt budget exhausted or publication still pending');
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(60_000);
    let admittedOwner: WorkerPreviewOwner | undefined;
    const done = Promise.resolve().then(async () => {
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request)); owner.assertOwner();
      admittedOwner = owner;
      if (!owner.config || !owner.store || owner.projectId == null || owner.projectId <= 0) throw new Error('Native export has no project attempt authority');
      const attemptId = owner.config.context.attemptId;
      if (closed) throw new Error('Native export bridge closed');
      drainingAttempts.assertOpen(request.runId, attemptId);
      const signal = AbortSignal.any([owner.signal, controller.signal, deadline]); signal.throwIfAborted();
      const name = request.authority?.toolName;
      if (name !== 'mcp__export_docs') throw new Error('Unknown native export mutation');
      const auth = await authorizeNativeApplicationDispatch(request, owner.config!, {
        name, key: `coder-${owner.sessionId}-attempt-${attemptId}`, operation: 'export/publish', args: {},
      }, owner.store!, owner.assertOwner);
      const assertCurrent = () => { signal.throwIfAborted(); auth.assertDispatch(); };
      assertCurrent();
      const service = getService();
      if (!service) throw new Error('Native export persistence unavailable');
      const result = await service.exportProject(owner.projectId!, request.authority!.input, { signal, assertCurrent });
      assertCurrent(); return result;
    });
    const call: Call = { digest, key: request.key, controller, done, bytes: -1 };
    calls.set(callId, call);
    void done.then(result => { call.bytes = Buffer.byteLength(result); receiptBytes += call.bytes; }, () => { call.bytes = 0; });
    const timer = setInterval(() => { try { admittedOwner?.assertOwner(); } catch (e) { controller.abort(e); } }, 100);
    timer.unref(); void done.finally(() => clearInterval(timer)).catch(() => undefined);
    return done;
  });
  const offCancel = bridge.handle('nativeExportCancel', async payload => {
    const request = payload as { requestId?: string; runId?: unknown };
    const owner = await getOwner(request?.runId, true, nativeApplicationTarget(request)); const call = calls.get(`coder-${owner.sessionId}-attempt-${owner.config?.context.attemptId}:${request?.requestId ?? ''}`);
    if (call) { call.controller.abort(new Error('Native export caller cancelled')); await call.done.catch(() => undefined); }
    return { closed: true };
  });
  const offDrain = bridge.handle('nativeExportDrain', async payload => {
    const request = payload as { runId?: unknown; attemptId?: string };
    const owner = await getOwner(request?.runId, true, nativeApplicationTarget(request));
    if (!owner.config || owner.config.context.attemptId !== request.attemptId) throw new Error('Native export drain has a foreign attempt');
    drainingAttempts.begin(request.runId, request.attemptId);
    const owned = [...calls].filter(([, call]) => call.key === `coder-${owner.sessionId}-attempt-${request.attemptId}`);
    for (const [, call] of owned) call.controller.abort(new Error('Native export attempt closed'));
    await Promise.allSettled(owned.map(([, call]) => call.done));
    for (const [id, call] of owned) { receiptBytes -= Math.max(0, call.bytes); calls.delete(id); }
    return { closed: true };
  });
  return () => { closed = true; off(); offCancel(); offDrain(); for (const call of calls.values()) call.controller.abort(new Error('Native export bridge closed')); };
}
