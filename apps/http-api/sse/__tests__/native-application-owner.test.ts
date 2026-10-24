import { expect, it, vi } from 'vitest';
import { nativeApplicationTarget, NativeAttemptDrainFence, resolveNativeApplicationOwner } from '../native-application-owner.js';
import type { WorkerPreviewOwner } from '../worker-preview-calls.js';

function fixture() {
  const owner = { sessionId: 's', projectId: 7, signal: new AbortController().signal, assertOwner: vi.fn(),
    config: { context: { agentRunId: 'root', attemptId: 'root-attempt' }, workspaceRoot: 'D:/owned' } } as unknown as WorkerPreviewOwner;
  const context = { agentRunId: 'child', attemptId: 'child-attempt' };
  const store = { resolveNativeChild: vi.fn().mockResolvedValue(context) };
  return { owner, context, store };
}
it('resolves the bound child from the root authority and preserves the host project and configuration', async () => {
  const f = fixture();
  const actual = await resolveNativeApplicationOwner(f.owner, f.store, 'child');
  expect(f.store.resolveNativeChild).toHaveBeenCalledWith(f.owner.config!.context, 'child', true);
  expect(actual).toMatchObject({ projectId: 7, config: { workspaceRoot: 'D:/owned', context: f.context } });
  expect(f.owner.config!.context.agentRunId).toBe('root');
  await resolveNativeApplicationOwner(f.owner, f.store, 'child', true);
  expect(f.store.resolveNativeChild).toHaveBeenLastCalledWith(f.owner.config!.context, 'child', false);
});
it('rejects foreign children and a worker replaced during durable lookup', async () => {
  const f = fixture(); f.store.resolveNativeChild.mockRejectedValueOnce(new Error('another tree'));
  await expect(resolveNativeApplicationOwner(f.owner, f.store, 'foreign')).rejects.toThrow('another tree');
  f.store.resolveNativeChild.mockImplementationOnce(async () => {
    (f.owner.assertOwner as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('stale worker'); }); return f.context;
  });
  await expect(resolveNativeApplicationOwner(f.owner, f.store, 'child')).rejects.toThrow('stale worker');
});
it('keeps root and legacy routing compatible without allowing a legacy child selector', async () => {
  const f = fixture();
  expect(await resolveNativeApplicationOwner(f.owner, f.store)).toBe(f.owner);
  expect(await resolveNativeApplicationOwner(f.owner, f.store, 'root')).toBe(f.owner);
  expect(f.store.resolveNativeChild).not.toHaveBeenCalled();
  const legacy = { ...f.owner, config: undefined };
  expect(await resolveNativeApplicationOwner(legacy, undefined)).toBe(legacy);
  await expect(resolveNativeApplicationOwner(legacy, undefined, 'child')).rejects.toThrow('native root');
});
it('rejects conflicting and malformed selectors before resolving an application owner', () => {
  expect(nativeApplicationTarget({ authority: { payload: { lease: { ownerAgentRunId: 'child' } } } })).toBe('child');
  expect(nativeApplicationTarget({ agentRunId: 'child' })).toBe('child');
  for (const value of ['', 7, 'x'.repeat(129)]) expect(() => nativeApplicationTarget({ agentRunId: value })).toThrow('selector');
  expect(() => nativeApplicationTarget({ agentRunId: 'one', authority: { payload: { lease: { ownerAgentRunId: 'two' } } } })).toThrow('differs');
});
it('keeps each drained sibling fenced and only resets when the owning root run changes', () => {
  const fence = new NativeAttemptDrainFence();
  fence.begin(1, 'a'); fence.begin(1, 'b');
  expect(() => fence.assertOpen(1, 'a')).toThrow('draining');
  expect(() => fence.assertOpen(1, 'b')).toThrow('draining');
  fence.assertOpen(1, 'c');
  for (let i = 2; i < 256; i++) fence.begin(1, `attempt-${i}`);
  expect(() => fence.begin(1, 'overflow')).toThrow('budget');
  fence.assertOpen(2, 'a'); fence.begin(2, 'fresh');
});
