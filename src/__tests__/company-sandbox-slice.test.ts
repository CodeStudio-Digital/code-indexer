import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createSandboxSlice,
  type SandboxSlice,
} from '@apps/dashboard/state/company/sandboxSlice.js';

type Store = UseBoundStore<StoreApi<SandboxSlice>>;

function makeStore(): Store {
  return create<SandboxSlice>()(createSandboxSlice);
}

describe('sandboxSlice', () => {
  let store: Store;

  beforeEach(() => {
    store = makeStore();
  });

  it('sandboxApplyFileChange seq is monotonic per session', () => {
    store.getState().sandboxApplyFileChange(7, { path: 'a.ts' });
    store.getState().sandboxApplyFileChange(7, { path: 'b.ts' });
    store.getState().sandboxApplyFileChange(7, { path: 'c.ts' });
    const last = store.getState().sandbox.get(7)!.lastFileChange!;
    expect(last.seq).toBe(3);
    expect(last.path).toBe('c.ts');
  });

  it('separate sessions keep independent counters', () => {
    store.getState().sandboxApplyFileChange(7, { path: 'a.ts' });
    store.getState().sandboxApplyFileChange(7, { path: 'b.ts' });
    store.getState().sandboxApplyFileChange(99, { path: 'x.ts' });
    expect(store.getState().sandbox.get(7)!.lastFileChange!.seq).toBe(2);
    expect(store.getState().sandbox.get(99)!.lastFileChange!.seq).toBe(1);
  });

  it('serviceId and changeType pass through to the slot', () => {
    store.getState().sandboxApplyFileChange(7, {
      path: 'src/main.ts',
      serviceId: 'api',
      changeType: 'modified',
    });
    const last = store.getState().sandbox.get(7)!.lastFileChange!;
    expect(last.serviceId).toBe('api');
    expect(last.changeType).toBe('modified');
  });

  it('records a timestamp at receive time', () => {
    const before = Date.now();
    store.getState().sandboxApplyFileChange(7, { path: 'a.ts' });
    const after = Date.now();
    const at = store.getState().sandbox.get(7)!.lastFileChange!.at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it('reset clears the slot', () => {
    store.getState().sandboxApplyFileChange(7, { path: 'a.ts' });
    store.getState().sandboxReset(7);
    expect(store.getState().sandbox.has(7)).toBe(false);
  });
});
