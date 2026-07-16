/**
 * Build a feature-store wrapper over the currently leased project DB handle.
 *
 * ProjectDbPool owns and may close/reopen the physical handle after LRU/TTL
 * eviction. Store wrappers only retain that raw handle, so caching a wrapper
 * outside the pool would leave it pointing at a closed database. The pool
 * already caches live connections; recreating this lightweight wrapper is the
 * correct lifetime boundary.
 */
export function createProjectFeatureStoreResolver<Handle, Store>(
  router: {
    useProjectDb(projectId: number): boolean;
    projectScopedDb(projectId: number): Handle;
  },
  centralStore: Store,
  createStore: (handle: Handle) => Store,
): (projectId: number) => Store {
  return (projectId) => router.useProjectDb(projectId)
    ? createStore(router.projectScopedDb(projectId))
    : centralStore;
}
