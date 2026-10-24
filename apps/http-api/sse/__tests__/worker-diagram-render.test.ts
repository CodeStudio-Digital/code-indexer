import { MessageChannel } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { setDiagramRenderer } from '@mcp/code-agent/tools/diagram/render-port.js';
import { registerWorkerDiagramRender } from '../worker-diagram-render.js';

afterEach(() => setDiagramRenderer(null));
it('rejects foreign owners and acknowledges cancellation only after renderer settlement', async () => {
  const channel = new MessageChannel(), main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const owner = new AbortController(); let release!: () => void;
  const render = vi.fn(async (_request, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
    signal!.addEventListener('abort', () => { release = () => reject(new Error('renderer closed')); }, { once: true });
  }));
  setDiagramRenderer({ render });
  const off = registerWorkerDiagramRender(main, runId => {
    if (runId !== 1) throw new Error('foreign owner');
    return { sessionId: 's', projectId: 2, signal: owner.signal, assertOwner() {} };
  });
  try {
    await expect(worker.request('diagramRender', { requestId: 'foreign', runId: 2 })).rejects.toThrow('foreign');
    expect(render).not.toHaveBeenCalled();
    const pending = worker.request('diagramRender', { requestId: 'one', runId: 1, xml: '<mxGraphModel/>', format: 'png' });
    const rejected = expect(pending).rejects.toThrow('renderer closed');
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    let acknowledged = false;
    const cancel = worker.request('diagramRenderCancel', { requestId: 'one' }).then(() => { acknowledged = true; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(acknowledged).toBe(false); release(); await cancel; await rejected;
    expect(acknowledged).toBe(true);
  } finally { release?.(); off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); }
});
