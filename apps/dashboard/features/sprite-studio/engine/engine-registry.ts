/**
 * Module-level engine registry — this is what survives route unmounts.
 * Navigating away from /sprites unmounts the React tree, but the engine
 * (pixels, layers, undo stack, viewport) stays here; coming back reattaches.
 * LRU of 2: the least-recently-used engine is disposed when a third opens.
 */
import type { EditorEngine } from './EditorEngine.js';

const MAX_ENGINES = 2;

/** Insertion order = recency (Map preserves it; touch = delete + set). */
const registry = new Map<string, EditorEngine>();

export function engineKey(projectId: number | string, assetId: number | string): string {
  return `${projectId}:${assetId}`;
}

export function getEngine(key: string): EditorEngine | undefined {
  const engine = registry.get(key);
  if (engine) {
    registry.delete(key);
    registry.set(key, engine); // touch
  }
  return engine;
}

export function getOrCreateEngine(key: string, create: () => EditorEngine): EditorEngine {
  const existing = getEngine(key);
  if (existing) return existing;
  const engine = create();
  registry.set(key, engine);
  while (registry.size > MAX_ENGINES) {
    const oldest = registry.keys().next().value as string;
    disposeEngine(oldest);
  }
  return engine;
}

export function disposeEngine(key: string): void {
  const engine = registry.get(key);
  if (!engine) return;
  registry.delete(key);
  engine.dispose();
}

/** Project close / app teardown. */
export function disposeAllEngines(): void {
  for (const key of [...registry.keys()]) disposeEngine(key);
}
