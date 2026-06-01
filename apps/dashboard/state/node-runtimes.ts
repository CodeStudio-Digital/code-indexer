/**
 * In-memory cache of detected Node runtimes (from `runtime.listNode`).
 * The per-project choice lives in the DB (projects.node_version); this
 * store just avoids re-detecting on every picker/chip mount. Call
 * `loadNodeRuntimes()` to (re)fetch — e.g. after a download/remove.
 */

import { create } from 'zustand';
import type { NodeRuntime } from '@mcp/api-bus';
import { apiCall } from '../lib/api-client.js';

interface NodeRuntimesState {
  runtimes: NodeRuntime[];
  loaded: boolean;
  loading: boolean;
  setRuntimes: (runtimes: NodeRuntime[]) => void;
  setLoading: (loading: boolean) => void;
}

export const useNodeRuntimes = create<NodeRuntimesState>((set) => ({
  runtimes: [],
  loaded: false,
  loading: false,
  setRuntimes: (runtimes) => set({ runtimes, loaded: true, loading: false }),
  setLoading: (loading) => set({ loading }),
}));

/** Fetch the detected runtimes into the store. Safe to call repeatedly. */
export async function loadNodeRuntimes(): Promise<NodeRuntime[]> {
  useNodeRuntimes.getState().setLoading(true);
  try {
    const list = await apiCall<NodeRuntime[]>('runtime.listNode', {});
    useNodeRuntimes.getState().setRuntimes(Array.isArray(list) ? list : []);
    return list;
  } catch {
    useNodeRuntimes.getState().setRuntimes([]);
    return [];
  }
}

/** Human label for a stored node_version id, falling back to the id. */
export function labelForNode(runtimes: NodeRuntime[], id: string | null): string {
  if (!id || id === 'system') return '';
  return runtimes.find((r) => r.id === id)?.label ?? id;
}
