/**
 * Per-plugin key-value storage capability. Thin gate over PluginStorageStore,
 * scoped to the calling plugin's namespace. Gated on the `storage` grant.
 */
import type { PluginStorageStore } from '@mcp/store/plugin-storage-store.js';

export function handleStorage(
  method: string,
  payload: unknown,
  namespace: string,
  store: PluginStorageStore,
  granted: boolean,
): unknown {
  if (!granted) throw new Error('permission_denied: storage not granted');
  const op = method.slice('storage.'.length);
  const key = (payload as { key?: string }).key ?? '';
  switch (op) {
    case 'get':
      return store.get(namespace, key);
    case 'set':
      store.set(namespace, key, (payload as { value?: string }).value ?? '');
      return null;
    case 'delete':
      store.delete(namespace, key);
      return null;
    case 'list':
      return store.listKeys(namespace);
    default:
      throw new Error(`permission_denied: unknown storage op: ${op}`);
  }
}
