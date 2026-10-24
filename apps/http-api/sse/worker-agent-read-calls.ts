import type { MessageBridge } from '@mcp/orchestrator-host';
import { AGENT_READ_NAMES, type AgentReadName } from '@mcp/code-agent/ports/agent-read-port.js';
import type { WorkerApplicationOwnerResolver } from './worker-application-owner.js';

export interface OwnedAgentReadService {
  read(projectId: number, name: AgentReadName, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export function registerWorkerAgentReadCalls(bridge: MessageBridge,
  getOwner: WorkerApplicationOwnerResolver,
  getService: () => OwnedAgentReadService | null | undefined) {
  const calls = new Map<string, { runId: number; controller: AbortController; done: Promise<unknown> }>();
  let closed = false;
  const off = bridge.handle('ownedAgentRead', async payload => {
    const packet = payload as { requestId: string; runId: number; name: AgentReadName; input: Record<string, unknown> };
    if (closed || !packet || typeof packet.requestId !== 'string' || !packet.requestId || packet.requestId.length > 128
      || !AGENT_READ_NAMES.includes(packet.name) || !packet.input || typeof packet.input !== 'object' || Array.isArray(packet.input)
      || JSON.stringify(packet.input).length > 32 * 1024 || calls.has(packet.requestId) || calls.size >= 16) throw new Error('Invalid or saturated agent read');
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(10_000);
    const done = Promise.resolve().then(async () => {
      const owner = await getOwner(packet.runId); owner.assertOwner();
      if (closed) throw new Error('Agent read bridge closed');
      if (!owner.projectId || owner.projectId <= 0) throw new Error('Agent read has no project owner');
      const service = getService(); if (!service) throw new Error('Owned agent reads unavailable');
      const signal = AbortSignal.any([controller.signal, owner.signal, deadline]);
      signal.throwIfAborted(); owner.assertOwner();
      const result = await service.read(owner.projectId!, packet.name, packet.input, signal);
      signal.throwIfAborted(); owner.assertOwner();
      if (Buffer.byteLength(JSON.stringify(result) ?? 'null') > 8 * 1024 * 1024) throw new Error('Agent read exceeds response budget');
      return result;
    });
    calls.set(packet.requestId, { runId: packet.runId, controller, done });
    try { return await done; } finally { calls.delete(packet.requestId); }
  });
  const offCancel = bridge.handle('ownedAgentReadCancel', async payload => {
    const packet = payload as { requestId: string; runId: number };
    await getOwner(packet?.runId, true);
    const call = calls.get(packet?.requestId);
    if (call && call.runId !== packet.runId) throw new Error('Agent read cancellation has a foreign run');
    if (call) { call.controller.abort(new Error('Agent read cancelled')); await call.done.catch(() => undefined); }
    return { closed: true };
  });
  return () => { closed = true; off(); offCancel(); for (const call of calls.values()) call.controller.abort(new Error('Agent read bridge closed')); };
}
