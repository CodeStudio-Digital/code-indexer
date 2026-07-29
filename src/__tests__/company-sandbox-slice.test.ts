import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createSandboxSlice,
  type SandboxSlice,
} from '@apps/dashboard/state/company/sandboxSlice.js';

type Store = UseBoundStore<StoreApi<SandboxSlice>>;

const SESSION_ID = '00000000-0000-4000-8000-000000000007';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000099';

function makeStore(): Store {
  return create<SandboxSlice>()(createSandboxSlice);
}

describe('sandboxSlice', () => {
  let store: Store;

  beforeEach(() => {
    store = makeStore();
  });

  it('sandboxApplyFileChange seq is monotonic per session', () => {
    store.getState().sandboxApplyFileChange(SESSION_ID, { path: 'a.ts' });
    store.getState().sandboxApplyFileChange(SESSION_ID, { path: 'b.ts' });
    store.getState().sandboxApplyFileChange(SESSION_ID, { path: 'c.ts' });
    const last = store.getState().sandbox.get(SESSION_ID)!.lastFileChange!;
    expect(last.seq).toBe(3);
    expect(last.path).toBe('c.ts');
  });

  it('separate sessions keep independent counters', () => {
    store.getState().sandboxApplyFileChange(SESSION_ID, { path: 'a.ts' });
    store.getState().sandboxApplyFileChange(SESSION_ID, { path: 'b.ts' });
    store.getState().sandboxApplyFileChange(OTHER_SESSION_ID, { path: 'x.ts' });
    expect(store.getState().sandbox.get(SESSION_ID)!.lastFileChange!.seq).toBe(2);
    expect(store.getState().sandbox.get(OTHER_SESSION_ID)!.lastFileChange!.seq).toBe(1);
  });

  it('serviceId and changeType pass through to the slot', () => {
    store.getState().sandboxApplyFileChange(SESSION_ID, {
      path: 'src/main.ts',
      serviceId: 'api',
      changeType: 'modified',
    });
    const last = store.getState().sandbox.get(SESSION_ID)!.lastFileChange!;
    expect(last.serviceId).toBe('api');
    expect(last.changeType).toBe('modified');
  });

  it('records a timestamp at receive time', () => {
    const before = Date.now();
    store.getState().sandboxApplyFileChange(SESSION_ID, { path: 'a.ts' });
    const after = Date.now();
    const at = store.getState().sandbox.get(SESSION_ID)!.lastFileChange!.at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it('reset clears the slot', () => {
    store.getState().sandboxApplyFileChange(SESSION_ID, { path: 'a.ts' });
    store.getState().sandboxReset(SESSION_ID);
    expect(store.getState().sandbox.has(SESSION_ID)).toBe(false);
  });
});
