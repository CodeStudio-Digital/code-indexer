/**
 * InMemoryRoleEmbeddingStore — roles change with each template revision,
 * so a Map per-process is enough. The key encodes role + skills so a
 * template tweak invalidates the cache automatically.
 */
import type { RoleEmbeddingStore } from './stages.js';

export class InMemoryRoleEmbeddingStore implements RoleEmbeddingStore {
  private map = new Map<string, Float32Array>();
  get(key: string): Float32Array | undefined { return this.map.get(key); }
  set(key: string, embedding: Float32Array): void { this.map.set(key, embedding); }
  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}
