/**
 * Module-level engine registry — this is what survives route unmounts.
 * Navigating away from /sprites unmounts the React tree, but the engine
 * (pixels, layers, undo stack, viewport) stays here; coming back reattaches.
 *
 * There is NO LRU eviction: each open editor TAB owns exactly one engine, and
 * engines are disposed ONLY explicitly — closing a tab, deleting an asset, or
 * switching project (disposeAllEngines). An LRU cap would silently destroy an
 * open tab's unsaved edits, so the tab list is the sole bound on live engines.
 */
import type { EditorEngine } from './EditorEngine.js';

/** Insertion order = recency (Map preserves it; touch = delete + set). */
const registry = new Map<string, EditorEngine>();

/** One engine per open IMAGE: a version, or the blank doc of a new asset.
 *  Keying by version (not asset) is what makes editor tabs per-image — two
 *  frames of the same asset are independent documents with independent undo. */
export function engineKey(
  projectId: number | string,
  assetId: string,
  versionId?: string | null,
): string {
  return `${projectId}:${assetId}:${versionId ?? 'new'}`;
}

export function getEngine(key: string): EditorEngine | undefined {
  const engine = registry.get(key);
  if (engine) {
    registry.delete(key);
    registry.set(key, engine); // touch
  }
  return engine;
}

/** Read without touching recency — for passive UI reads (tab dirty dots). */
export function peekEngine(key: string): EditorEngine | undefined {
  return registry.get(key);
}

export function getOrCreateEngine(key: string, create: () => EditorEngine): EditorEngine {
  const existing = getEngine(key);
  if (existing) return existing;
  const engine = create();
  registry.set(key, engine);
  return engine;
}

export function disposeEngine(key: string): void {
  const engine = registry.get(key);
  if (!engine) return;
  registry.delete(key);
  engine.dispose();
}

/** Dispose every engine whose key starts with `prefix` (e.g. all of one
 *  asset's version engines when the asset is deleted). */
export function disposeEnginesByPrefix(prefix: string): void {
  for (const key of [...registry.keys()]) {
    if (key.startsWith(prefix)) disposeEngine(key);
  }
}

/** Project close / app teardown. */
export function disposeAllEngines(): void {
  for (const key of [...registry.keys()]) disposeEngine(key);
}
