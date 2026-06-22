/**
 * In-memory cache of detected runtimes per kind (from `runtime.list`). The
 * per-project choice lives in the DB (projects.node_version for Node;
 * projects.runtime_versions JSON for PHP/Python); this store just avoids
 * re-detecting on every picker/chip mount. Call `loadRuntimes(kind)` to
 * (re)fetch — e.g. after an install/uninstall.
 */

import { create } from 'zustand';
import type { Runtime, RuntimeKind } from '@mcp/api-bus';
import { apiCall } from '../lib/api-client.js';

type ByKind<T> = Record<RuntimeKind, T>;

interface RuntimesState {
  byKind: ByKind<Runtime[]>;
  loaded: ByKind<boolean>;
  set: (kind: RuntimeKind, runtimes: Runtime[]) => void;
}

export const useRuntimes = create<RuntimesState>((set) => ({
  byKind: { node: [], php: [], python: [] },
  loaded: { node: false, php: false, python: false },
  set: (kind, runtimes) =>
    set((s) => ({
      byKind: { ...s.byKind, [kind]: runtimes },
      loaded: { ...s.loaded, [kind]: true },
    })),
}));

/** Fetch the detected runtimes of a kind into the store. Safe to call repeatedly. */
export async function loadRuntimes(kind: RuntimeKind): Promise<Runtime[]> {
  try {
    const list = await apiCall<Runtime[]>('runtime.list', { kind });
    const arr = Array.isArray(list) ? list : [];
    useRuntimes.getState().set(kind, arr);
    return arr;
  } catch {
    useRuntimes.getState().set(kind, []);
    return [];
  }
}
