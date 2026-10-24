import type { MessageBridge } from '@mcp/orchestrator-host';
import type { MemoryMutationCall, MemoryMutationPort, MemoryMutationResult } from '@mcp/code-agent/ports/memory-mutation-port.js';
import type { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';

export class NativeMemoryPort implements MemoryMutationPort {
  constructor(private readonly options: { bridge: MessageBridge; runId: number; agentRunId?: string; key: string; payload: unknown;
    signal: AbortSignal; effects: HostEffectScope; assertCurrent(): void; outcomeUnknown(): void }) {}
  invoke(call: MemoryMutationCall): Promise<MemoryMutationResult> {
    const signal = AbortSignal.any([this.options.signal, ...(call.signal ? [call.signal] : [])]);
    signal.throwIfAborted(); this.options.assertCurrent();
    if (!call.toolUseId || !call.binding) throw new Error('Native memory requires an attributed resource binding');
    return this.options.effects.track(async () => {
      signal.throwIfAborted(); this.options.assertCurrent();
      const requestId = call.toolUseId!;
      const cancel = () => { void this.options.bridge.request('nativeMemoryCancel', { requestId, runId: this.options.runId, agentRunId: this.options.agentRunId }, { timeoutMs: 35_000 }).catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await this.options.bridge.request<MemoryMutationResult>('nativeMemoryMutate', {
          requestId, runId: this.options.runId, key: this.options.key,
          authority: { payload: this.options.payload, binding: call.binding, toolUseId: call.toolUseId, toolName: call.toolName, input: call.input },
        }, { timeoutMs: 35_000 });
        signal.throwIfAborted(); this.options.assertCurrent(); return result;
      } catch (error) { this.options.outcomeUnknown(); throw error; }
      finally { signal.removeEventListener('abort', cancel); }
    });
  }
}
