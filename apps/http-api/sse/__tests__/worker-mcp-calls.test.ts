import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { MessageBridge } from '../../../../packages/orchestrator-host/src/index.js';
import { registerWorkerMcpCalls } from '../worker-mcp-calls.js';
import { RemoteMcpServerManager } from '../../workers/RemoteMcpServerManager.js';
import type { McpExternalPool } from '../McpExternalPool.js';
import type { ToolContext } from '../../../../packages/code-agent/src/core/tool.js';

it('cancels only the owning bridge call and preserves ambiguous effects and image results', async () => {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 });
  const worker = new MessageBridge({ port: channel.port2 });
  const signals: AbortSignal[] = [];
  let release!: () => void;
  const result = { content: 'frame', structuredData: { revision: 7 },
    extraUserBlocks: [{ type: 'image' as const, mediaType: 'image/png', base64: 'aW1hZ2U=' }] };
  const callTool = vi.fn(async (_server, _tool, args, signal) => {
    signals.push(signal);
    if (args.wait) await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, text: result.content, result };
  });
  const off = registerWorkerMcpCalls(main, () => ({ callTool } as unknown as McpExternalPool));
  main.handle('mcpExt.snapshot', () => ({ tools: [{ name: 'ext_fixture__write', description: '',
    parameters: { type: 'object', properties: {} }, repeatable: false, serverId: 'fixture', toolName: 'write' }], tierMap: [] }));
  const controller = new AbortController();
  try {
    const manager = new RemoteMcpServerManager(worker); await manager.connectAll([]);
    const { tools } = await manager.listAllTools();
    expect(tools[0]).toMatchObject({ mutates: true, parallelSafe: false, capabilityProvenance: { serverId: 'fixture' } });
    const pending = tools[0].handler({ wait: true }, { signal: controller.signal } as ToolContext);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort();
    expect(await pending).toMatchObject({ effectOutcome: 'unknown', error: { retryable: false } });
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
    expect(await tools[0].handler({}, {} as ToolContext)).toEqual(result);
    expect(signals[1].aborted).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(2);
    release();
  } finally {
    release?.(); off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close();
  }
});

it('rejects old run IDs and retains the owner check through delayed wire dispatch', async () => {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  let currentRun = 1, effects = 0, release!: () => void;
  const callTool = vi.fn(async (_server, _tool, _args, _signal, _revision, assertDispatch) => {
    await new Promise<void>(r => { release = r; });
    try { assertDispatch(); } catch { return { ok: false, text: 'inactive', result: { isError: true, content: 'inactive' } }; }
    effects++; return { ok: true, text: 'ok', result: { content: 'ok' } };
  });
  const off = registerWorkerMcpCalls(main, () => ({ callTool } as unknown as McpExternalPool), ({ runId }) => () => {
    if (runId !== currentRun) throw Error('stale run');
  });
  const payload = { serverId: 'fixture', toolName: 'write', args: {}, callId: 'request-12345', runId: 1 };
  try {
    const pending = worker.request('mcpExt.callTool', payload);
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    currentRun = 2; release();
    expect(await pending).toMatchObject({ ok: false });
    expect(await worker.request('mcpExt.callTool', { ...payload, callId: 'request-23456' })).toMatchObject({ ok: false });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(effects).toBe(0);
  } finally { release?.(); off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); }
});

it('cancels an ownership lookup before it can dispatch to the pool', async () => {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  let release!: () => void;
  const callTool = vi.fn();
  const off = registerWorkerMcpCalls(main, () => ({ callTool } as unknown as McpExternalPool), async () => {
    await new Promise<void>(r => { release = r; }); return () => {};
  });
  try {
    const pending = worker.request('mcpExt.callTool', { callId: 'waiting-owner-1', serverId: 'fixture', toolName: 'write', args: {} });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await worker.request('mcpExt.cancelTool', { callId: 'waiting-owner-1' });
    release(); expect(await pending).toMatchObject({ ok: false }); expect(callTool).not.toHaveBeenCalled();
  } finally { release?.(); off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); }
});
