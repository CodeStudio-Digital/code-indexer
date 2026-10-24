import { expect, it, vi } from 'vitest';
import { NativeMemoryPort } from '../workers/native-memory-port.js';
import { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';
function fixture() {
  const request = vi.fn(); const controller = new AbortController(); const effects = new HostEffectScope(); const outcomeUnknown = vi.fn();
  const port = new NativeMemoryPort({ bridge: { request } as any, runId: 1, key: 'key', payload: {}, signal: controller.signal,
    effects, assertCurrent() {}, outcomeUnknown });
  return { port, request, controller, effects, outcomeUnknown };
}
const call = { toolName: 'remember' as const, input: { title: 'x', content: 'y' }, toolUseId: 'tool', binding: {} as any };
it('never resends a write after a lost response and classifies the outcome as uncertain', async () => {
  const f = fixture(); f.request.mockRejectedValue(new Error('ACK lost'));
  await expect(f.port.invoke(call)).rejects.toThrow('ACK lost');
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.outcomeUnknown).toHaveBeenCalledOnce();
  await f.effects.waitForIdle(); expect(f.effects.activeCount).toBe(0);
});
it('keeps the real effect owned after cancellation until the transport settles', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.request.mockImplementation(method => method === 'nativeMemoryMutate' ? new Promise(r => { finish = r; }) : Promise.resolve({ closed: true }));
  const pending = f.port.invoke(call); const rejected = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.controller.abort(new Error('cancelled')); expect(f.effects.activeCount).toBe(1);
  expect(f.request).toHaveBeenLastCalledWith('nativeMemoryCancel', { requestId: 'tool', runId: 1 }, expect.any(Object));
  finish({ created: 1, merged: 0, skipped: 0 }); await rejected; await f.effects.waitForIdle();
  expect(f.effects.activeCount).toBe(0); expect(f.outcomeUnknown).toHaveBeenCalledOnce();
});
it('rejects cancellation and missing attribution before any dispatch', () => {
  const f = fixture(); expect(() => f.port.invoke({ ...call, binding: undefined })).toThrow('attributed');
  f.controller.abort(new Error('cancelled')); expect(() => f.port.invoke(call)).toThrow('cancelled');
  expect(f.request).not.toHaveBeenCalled(); expect(f.outcomeUnknown).not.toHaveBeenCalled();
});
