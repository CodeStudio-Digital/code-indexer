import type { MessageBridge } from '@mcp/orchestrator-host';
import type { DocumentExportPort } from '@mcp/code-agent/ports/document-export-port.js';
import type { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';

export class NativeDocumentExportPort implements DocumentExportPort {
  constructor(private readonly options: { bridge: MessageBridge; runId: number; agentRunId?: string; key: string; payload: unknown;
    signal: AbortSignal; effects: HostEffectScope; assertCurrent(): void; outcomeUnknown(): void }) {}
  invoke(call: Parameters<DocumentExportPort['invoke']>[0]): Promise<string> {
    const signal = AbortSignal.any([this.options.signal, ...(call.signal ? [call.signal] : [])]);
    signal.throwIfAborted(); this.options.assertCurrent();
    if (!call.toolUseId || !call.binding) throw new Error('Native export requires an attributed resource binding');
    return this.options.effects.track(async () => {
      signal.throwIfAborted(); this.options.assertCurrent();
      const requestId = call.toolUseId!;
      const cancel = () => { void this.options.bridge.request('nativeExportCancel', { requestId, runId: this.options.runId, agentRunId: this.options.agentRunId }, { timeoutMs: 65_000 }).catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await this.options.bridge.request<string>('nativeExportPublish', {
          requestId, runId: this.options.runId, key: this.options.key,
          authority: { payload: this.options.payload, binding: call.binding, toolUseId: call.toolUseId, toolName: 'mcp__export_docs', input: call.input },
        }, { timeoutMs: 65_000 });
        signal.throwIfAborted(); this.options.assertCurrent(); return result;
      } catch (error) { this.options.outcomeUnknown(); throw error; }
      finally { signal.removeEventListener('abort', cancel); }
    });
  }
}
