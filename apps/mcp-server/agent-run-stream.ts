import { classifyCoderTerminalOutcome, type ClassifiedCoderTerminalOutcome } from '@mcp/agent-runtime-contracts';
import { readSSEEvents, SSEStreamInterruptedError } from '@mcp/shared/sse/readSSEEvents.js';

export { SSEStreamInterruptedError as AgentStreamInterruptedError } from '@mcp/shared/sse/readSSEEvents.js';

/** Drain progress incrementally; EOF and HTTP 200 are not completion receipts. */
export async function readMcpAgentTerminal(response: Response,
  signal: AbortSignal, identity?: { expected?: string; observed?(busId: string): void }): Promise<ClassifiedCoderTerminalOutcome> {
  let matched = identity?.expected === undefined;
  for await (const event of readSSEEvents(response, signal)) {
    if (event.event === 'bus_info') {
      let busId: unknown;
      try { busId = (JSON.parse(event.data) as { bus_id?: unknown }).bus_id; }
      catch { throw new SSEStreamInterruptedError('Agent stream identity is malformed'); }
      if (typeof busId !== 'string' || !busId) throw new SSEStreamInterruptedError('Agent stream identity is missing');
      if (identity?.expected && busId !== identity.expected) throw new SSEStreamInterruptedError('Agent stream belongs to a different run');
      matched = true; identity?.observed?.(busId);
    }
    if (event.event !== 'done' && event.event !== 'error') continue;
    if (!matched) throw new SSEStreamInterruptedError('Agent terminal omitted its expected run identity');
    let data: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(event.data);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal');
      data = value as Record<string, unknown>;
    } catch { throw new SSEStreamInterruptedError('Agent stream terminal is malformed'); }
    return classifyCoderTerminalOutcome({ event: event.event, reason: data.reason,
      error: data.error, message: data.message });
  }
  throw new SSEStreamInterruptedError('Agent stream ended without a terminal receipt; execution was not retried');
}
