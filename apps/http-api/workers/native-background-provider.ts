import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';

const coordinationTools = new Set(['send_message', 'send_input', 'followup_task', 'collect_agents', 'list_agents', 'wait_agents']);
export function isNativeTreeCoordinationTool(name: string): boolean { return coordinationTools.has(name); }

/** Keep ordinary completion on the provider lane until background children
 * settle. The terminal journal ACK must never carry a minutes-long job wait. */
export function withNativeBackgroundDrain(provider: ChatProvider, drain: () => Promise<void>): ChatProvider {
  return { name: provider.name, model: provider.model, setModel: provider.setModel.bind(provider),
    async *chat(request) {
      let tools = false;
      const preparedTools = new Set<string>();
      for await (const delta of provider.chat(request)) {
        if (delta.type === 'tool_call_start' || delta.type === 'tool_call_end') {
          // Child delegation fences the parent's workspace. Wait on the
          // provider lane before Rust prepares the next resource grant; a
          // Data ACK or policy RPC must not carry a long background wait.
          if (!preparedTools.has(delta.id) && !isNativeTreeCoordinationTool(delta.name)) await abortableDrain(drain, request.signal);
          preparedTools.add(delta.id);
        }
        if (delta.type === 'tool_call_start' || delta.type === 'tool_call_end') tools = true;
        if (delta.type === 'done' && !tools) await abortableDrain(drain, request.signal);
        yield delta;
      }
    } };
}

async function abortableDrain(drain: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return drain();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { await Promise.race([drain(), cancelled]); signal.throwIfAborted(); }
  finally { signal.removeEventListener('abort', abort); }
}
