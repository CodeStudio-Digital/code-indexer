import { describe, expect, it, vi } from 'vitest';
import { createProjectFeatureStoreResolver } from '../project-feature-store.js';

describe('createProjectFeatureStoreResolver', () => {
  it('returns the central singleton while project routing is disabled', () => {
    const central = { handle: 'central' };
    const createStore = vi.fn((handle: string) => ({ handle }));
    const resolve = createProjectFeatureStoreResolver({
      useProjectDb: () => false,
      projectScopedDb: () => 'project',
    }, central, createStore);

    expect(resolve(7)).toBe(central);
    expect(createStore).not.toHaveBeenCalled();
  });

  it('re-wraps the current pooled handle after eviction instead of caching a stale store', () => {
    let currentHandle = 'lease-1';
    const createStore = vi.fn((handle: string) => ({ handle }));
    const resolve = createProjectFeatureStoreResolver({
      useProjectDb: () => true,
      projectScopedDb: () => currentHandle,
    }, { handle: 'central' }, createStore);

    const first = resolve(7);
    currentHandle = 'lease-2';
    const reopened = resolve(7);

    expect(first).toEqual({ handle: 'lease-1' });
    expect(reopened).toEqual({ handle: 'lease-2' });
    expect(reopened).not.toBe(first);
    expect(createStore).toHaveBeenCalledTimes(2);
  });
});
