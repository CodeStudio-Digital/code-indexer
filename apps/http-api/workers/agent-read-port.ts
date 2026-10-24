import { randomUUID } from 'node:crypto';
import type { MessageBridge } from '@mcp/orchestrator-host';
import type { AgentReadPort } from '@mcp/code-agent/ports/agent-read-port.js';

export function createWorkerAgentReadPort(bridge: MessageBridge, runId: number, runSignal: AbortSignal,
  assertCurrent: () => void, agentRunId?: string): AgentReadPort {
  return { async read(name, input, callerSignal) {
    const signal = callerSignal ? AbortSignal.any([runSignal, callerSignal]) : runSignal;
    signal.throwIfAborted(); assertCurrent();
    const requestId = randomUUID();
    const cancel = () => { void bridge.request('ownedAgentReadCancel', { requestId, runId, agentRunId }, { timeoutMs: 15_000 }).catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await bridge.request('ownedAgentRead', { requestId, runId, agentRunId, name, input }, { timeoutMs: 15_000 });
      signal.throwIfAborted(); assertCurrent(); return result;
    } finally { signal.removeEventListener('abort', cancel); }
  } };
}
