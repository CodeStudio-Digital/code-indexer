import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { invokePreview, setGlobalPreviewDevtools } from '../preview/bridge.js';
import { invokeResearchBrowser, setGlobalResearchBrowser } from '../browser/bridge.js';

afterEach(() => { setGlobalPreviewDevtools(null); setGlobalResearchBrowser(null); });

describe.each([
  { name: 'preview', install: setGlobalPreviewDevtools, invoke: (ctx: ToolContext) => invokePreview(ctx, 'snapshot') },
  { name: 'browser', install: setGlobalResearchBrowser, invoke: (ctx: ToolContext) => invokeResearchBrowser(ctx, 'snapshot') },
])('$name RPC cancellation', ({ install, invoke }) => {
  const context = (signal: AbortSignal) => ({ cwd: process.cwd(), signal, sessionId: 'isolated' }) as ToolContext;

  it('does not dispatch an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const backend = { invoke: vi.fn(), cancel: vi.fn() }; install(backend);
    await expect(invoke(context(controller.signal))).rejects.toThrow(/aborted/);
    expect(backend.invoke).not.toHaveBeenCalled();
    expect(backend.cancel).not.toHaveBeenCalled();
  });

  it('handles abort during dispatch even when backend cancellation throws', async () => {
    const controller = new AbortController();
    const backend = {
      invoke: vi.fn((_request: unknown) => { controller.abort(); return new Promise(() => {}); }),
      cancel: vi.fn(() => { throw new Error('backend closed'); }),
    };
    install(backend);
    await expect(invoke(context(controller.signal))).rejects.toThrow(/aborted/);
    const request = backend.invoke.mock.calls[0]![0] as { requestId: string };
    expect(backend.cancel).toHaveBeenCalledWith(request.requestId);
  });

  it('detaches the listener after success and does not cancel a later request', async () => {
    const controller = new AbortController();
    const backend = { invoke: vi.fn(async () => 'confirmed'), cancel: vi.fn() }; install(backend);
    expect(await invoke(context(controller.signal))).toBe('confirmed');
    controller.abort();
    expect(backend.cancel).not.toHaveBeenCalled();
  });

  it('detaches the listener after synchronous dispatch failure', async () => {
    const controller = new AbortController();
    const backend = { invoke: vi.fn(() => { throw new Error('dispatch failed'); }), cancel: vi.fn() }; install(backend);
    await expect(invoke(context(controller.signal))).rejects.toThrow('dispatch failed');
    controller.abort();
    expect(backend.cancel).not.toHaveBeenCalled();
  });
});
