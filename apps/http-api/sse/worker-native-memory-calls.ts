import { createHash } from 'node:crypto';
import type { MessageBridge } from '@mcp/orchestrator-host';
import type { MemoryMutationResult, MemoryMutationTool } from '@mcp/code-agent/ports/memory-mutation-port.js';
import { memoryMutationArguments } from '@mcp/code-agent/tools/memory-mutation-arguments.js';
import { authorizeNativeApplicationDispatch, type NativeApplicationRequest } from '../native-application-dispatch.js';
import { nativeApplicationTarget, NativeAttemptDrainFence, type WorkerApplicationOwnerResolver } from './native-application-owner.js';
import type { WorkerMemoryDeps } from './worker-memory-handlers.js';
import type { WorkerPreviewOwner } from './worker-preview-calls.js';

export interface NativeMemoryRequest extends NativeApplicationRequest { requestId: string; runId: number }
type Call = { digest: string; key: string; controller: AbortController; done: Promise<MemoryMutationResult> };

/** One effect owner per worker. Keep receipts until drain so a duplicate packet
 * with a lost response cannot apply the mutation a second time. */
export function registerWorkerNativeMemoryCalls(bridge: MessageBridge,
  getOwner: WorkerApplicationOwnerResolver,
  getDeps: () => WorkerMemoryDeps | undefined): () => void {
  const calls = new Map<string, Call>();
  const drainingAttempts = new NativeAttemptDrainFence();
  let closed = false;
  const off = bridge.handle('nativeMemoryMutate', async payload => {
    const request = payload as NativeMemoryRequest;
    if (closed || typeof request?.requestId !== 'string' || request.requestId.length > 256 || !request.requestId
      || typeof request.key !== 'string' || !request.key || request.key.length > 256) throw new Error('Invalid native memory request');
    if (request.authority?.toolUseId !== request.requestId) throw new Error('Native memory request identity differs from its bound invocation');
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const callId = `${request.key}:${request.requestId}`;
    const previous = calls.get(callId);
    if (previous) {
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request)); owner.assertOwner();
      if (!owner.config || request.key !== `coder-${owner.sessionId}-attempt-${owner.config.context.attemptId}`) throw new Error('Native memory receipt has a foreign attempt');
      drainingAttempts.assertOpen(request.runId, owner.config.context.attemptId);
      if (previous.digest !== digest) throw new Error('Native memory operation ID has changed input');
      return previous.done;
    }
    if (calls.size >= 256) throw new Error('Native memory receipt budget exhausted');
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(30_000);
    let admittedOwner: WorkerPreviewOwner | undefined;
    const done = Promise.resolve().then(async () => {
      const owner = await getOwner(request.runId, false, nativeApplicationTarget(request)); owner.assertOwner();
      admittedOwner = owner;
      if (!owner.config || !owner.store) throw new Error('Native memory has no attempt authority');
      const attemptId = owner.config.context.attemptId;
      if (closed) throw new Error('Native memory bridge closed');
      drainingAttempts.assertOpen(request.runId, attemptId);
      const signal = AbortSignal.any([owner.signal, controller.signal, deadline]); signal.throwIfAborted();
      const name = request.authority?.toolName;
      if (name !== 'remember' && name !== 'forget_memory' && name !== 'mcp__save_memory') throw new Error('Unknown native memory mutation');
      const input = request.authority!.input;
      const args = memoryMutationArguments(name as MemoryMutationTool, input);
      const auth = await authorizeNativeApplicationDispatch(request, owner.config!, {
        name, key: `coder-${owner.sessionId}-attempt-${attemptId}`, databaseId: `memory:${args.scope}`,
        operation: name === 'remember' ? 'remember.save' : name === 'mcp__save_memory' ? 'save_memory.save' : 'forget_memory.archive', args: {},
      }, owner.store!, owner.assertOwner);
      const assertCurrent = () => { signal.throwIfAborted(); auth.assertDispatch(); };
      assertCurrent();
      const memory = getDeps()?.projectMemory;
      if (!memory) throw new Error('Native memory persistence unavailable');
      const projectId = args.scope === 'user' ? 0 : owner.projectId;
      if (projectId == null || (args.scope === 'project' && projectId <= 0)) throw new Error('Native memory requires a project');
      const control = { signal, assertCurrent, deferEmbeddings: true };
      let result: MemoryMutationResult;
      if ((name === 'remember' || name === 'mcp__save_memory') && args.entry) result = await memory.save(projectId, '', args.entry, control);
      else if (name === 'forget_memory' && args.target && memory.forget) result = await memory.forget(projectId, '', args.target, control);
      else throw new Error('Native memory operation unavailable');
      assertCurrent(); return result;
    });
    calls.set(callId, { digest, key: request.key, controller, done });
    const timer = setInterval(() => { try { admittedOwner?.assertOwner(); } catch (e) { controller.abort(e); } }, 100);
    timer.unref();
    void done.finally(() => clearInterval(timer)).catch(() => undefined);
    return done;
  });
  const offCancel = bridge.handle('nativeMemoryCancel', async payload => {
    const request = payload as { requestId?: string; runId?: unknown };
    const owner = await getOwner(request?.runId, true, nativeApplicationTarget(request));
    const call = calls.get(`coder-${owner.sessionId}-attempt-${owner.config?.context.attemptId}:${request?.requestId ?? ''}`);
    if (call) { call.controller.abort(new Error('Native memory caller cancelled')); await call.done.catch(() => undefined); }
    return { closed: true };
  });
  const offDrain = bridge.handle('nativeMemoryDrain', async payload => {
    const request = payload as { runId?: unknown; attemptId?: string };
    const owner = await getOwner(request?.runId, true, nativeApplicationTarget(request));
    if (!owner.config || owner.config.context.attemptId !== request.attemptId) throw new Error('Native memory drain has a foreign attempt');
    drainingAttempts.begin(request.runId, request.attemptId);
    const owned = [...calls].filter(([, call]) => call.key === `coder-${owner.sessionId}-attempt-${request.attemptId}`);
    for (const [, call] of owned) call.controller.abort(new Error('Native memory attempt closed'));
    await Promise.allSettled(owned.map(([, call]) => call.done));
    for (const [id] of owned) calls.delete(id);
    return { closed: true };
  });
  return () => { closed = true; off(); offCancel(); offDrain(); for (const call of calls.values()) call.controller.abort(new Error('Native memory bridge closed')); };
}
