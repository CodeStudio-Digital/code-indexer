import { expect, it, vi } from 'vitest';
import { NativeDocumentExportPort } from '../workers/native-document-export-port.js';
import { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';
function fixture() {
  const request = vi.fn(); const controller = new AbortController(); const effects = new HostEffectScope(); const outcomeUnknown = vi.fn();
  const port = new NativeDocumentExportPort({ bridge: { request } as any, runId: 1, key: 'key', payload: {}, signal: controller.signal,
    effects, assertCurrent() {}, outcomeUnknown });
  return { port, request, controller, effects, outcomeUnknown };
}
const call = { input: { sections: ['overview'] }, toolUseId: 'tool', binding: {} as any };
it('never resends a publication after a lost response', async () => {
  const f = fixture(); f.request.mockRejectedValue(new Error('ACK lost'));
  await expect(f.port.invoke(call)).rejects.toThrow('ACK lost');
  expect(f.request).toHaveBeenCalledOnce(); expect(f.outcomeUnknown).toHaveBeenCalledOnce();
  await f.effects.waitForIdle(); expect(f.effects.activeCount).toBe(0);
});
it('keeps an uncooperative publication owned until the real transport settles', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.request.mockImplementation(method => method === 'nativeExportPublish' ? new Promise(r => { finish = r; }) : Promise.resolve({ closed: true }));
  const pending = f.port.invoke(call); const rejected = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.controller.abort(new Error('cancelled')); expect(f.effects.activeCount).toBe(1);
  expect(f.request).toHaveBeenLastCalledWith('nativeExportCancel', { requestId: 'tool', runId: 1 }, expect.any(Object));
  finish('exported'); await rejected; await f.effects.waitForIdle();
  expect(f.effects.activeCount).toBe(0); expect(f.outcomeUnknown).toHaveBeenCalledOnce();
});
it('rejects already cancelled and unattributed requests without any transport call', () => {
  const f = fixture(); expect(() => f.port.invoke({ ...call, binding: undefined })).toThrow('attributed');
  f.controller.abort(new Error('cancelled')); expect(() => f.port.invoke(call)).toThrow('cancelled');
  expect(f.request).not.toHaveBeenCalled(); expect(f.outcomeUnknown).not.toHaveBeenCalled();
});
