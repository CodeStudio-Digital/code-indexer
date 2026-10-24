import type { MessageBridge } from '@mcp/orchestrator-host';
import { setDiagramRenderer } from '@mcp/code-agent/tools/diagram/render-port.js';

export function installDiagramRenderShim(bridge: MessageBridge, currentRun: () => unknown): void {
  setDiagramRenderer({
    async render(request, signal) {
      signal?.throwIfAborted();
      let cancellation: Promise<unknown> | undefined;
      const cancel = () => { cancellation ??= bridge.request('diagramRenderCancel', { requestId: request.requestId }, { timeoutMs: 5000 }); void cancellation.catch(() => undefined); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const image = await bridge.request<string>('diagramRender', { ...request, runId: currentRun() }, { timeoutMs: 35000 });
        signal?.throwIfAborted(); return image;
      } catch (error) { cancel(); throw error; }
      finally { signal?.removeEventListener('abort', cancel); await cancellation; }
    },
  });
}
