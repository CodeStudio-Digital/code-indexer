/**
 * InMemoryRoleEmbeddingStore — roles change with each template revision,
 * so a Map per-process is enough. The key encodes role + skills so a
 * template tweak invalidates the cache automatically.
 */
import type { RoleEmbeddingStore } from './stages.js';

export class InMemoryRoleEmbeddingStore implements RoleEmbeddingStore {
  private map = new Map<string, Float32Array>();
  private key(roleKey: string, fingerprint: string): string { return JSON.stringify([fingerprint, roleKey]); }
  get(roleKey: string, fingerprint: string): Float32Array | undefined {
    return this.map.get(this.key(roleKey, fingerprint));
  }
  set(roleKey: string, fingerprint: string, embedding: Float32Array): void {
    this.map.set(this.key(roleKey, fingerprint), embedding);
  }
  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}
