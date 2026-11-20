/**
 * Tiny TTL+LRU map shared by the autocomplete pipeline (result cache,
 * member micro-cache). Module-level cache instances built on this are shared
 * across both `createEditorHandlers` instances on Electron (IPC mount + HTTP route
 * dispatch fallback).
 *
 * Project-knowledge context building moved to `completion/` (the layered
 * tiers — scope/members/siblings/imports). This file is now just the cache
 * primitive those modules and the handler share.
 */

/** Tiny TTL+LRU map (Map preserves insertion order → first key is oldest). */
export class TtlLru<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();
  constructor(private cap: number, private ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < performance.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  /** `ttlMs` overrides the instance TTL for this entry (latency policy). */
  set(key: string, value: V, ttlMs?: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: performance.now() + (ttlMs ?? this.ttlMs) });
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
