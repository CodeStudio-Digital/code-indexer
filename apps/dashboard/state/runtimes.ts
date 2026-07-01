/**
 * In-memory cache of detected runtimes per (kind, target) (from `runtime.list`).
 * The per-project choice lives in the DB (node_version / runtime_versions for the
 * host; wsl_runtime_versions for a WSL distro); this store just avoids
 * re-detecting on every picker/pane mount. Keyed by target so the Host list and
 * each WSL distro's list don't collide. Call `loadRuntimes(kind, target)` to
 * (re)fetch — e.g. after an install/uninstall.
 */

import { create } from 'zustand';
import type { Runtime, RuntimeKind, RuntimeTarget } from '@mcp/api-bus';
import { apiCall } from '../lib/api-client.js';

/** Stable string id for a runtime target ('host' | 'wsl:<distro>'). */
export function runtimeTargetKey(target: RuntimeTarget | undefined): string {
  return target?.kind === 'wsl' ? `wsl:${target.distro}` : 'host';
}

/** Cache key for a (kind, target) pair. */
export function runtimeCacheKey(kind: RuntimeKind, target?: RuntimeTarget): string {
  return `${runtimeTargetKey(target)}:${kind}`;
}

interface RuntimesState {
  byKey: Record<string, Runtime[]>;
  loadedKey: Record<string, boolean>;
  set: (key: string, runtimes: Runtime[]) => void;
}

export const useRuntimes = create<RuntimesState>((set) => ({
  byKey: {},
  loadedKey: {},
  set: (key, runtimes) =>
    set((s) => ({
      byKey: { ...s.byKey, [key]: runtimes },
      loadedKey: { ...s.loadedKey, [key]: true },
    })),
}));

/** Fetch the detected runtimes of a (kind, target) into the store. Safe to call repeatedly. */
export async function loadRuntimes(kind: RuntimeKind, target?: RuntimeTarget): Promise<Runtime[]> {
  const key = runtimeCacheKey(kind, target);
  try {
    const list = await apiCall<Runtime[]>('runtime.list', { kind, target });
    const arr = Array.isArray(list) ? list : [];
    useRuntimes.getState().set(key, arr);
    return arr;
  } catch {
    useRuntimes.getState().set(key, []);
    return [];
  }
}
