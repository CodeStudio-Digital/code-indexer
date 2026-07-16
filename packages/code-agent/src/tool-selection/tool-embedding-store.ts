/**
 * In-memory ToolEmbeddingStore.
 *
 * Tools change rarely — the embedding for "Read: reads a file at a path"
 * is the same across thousands of sessions. A small Map in process is fine;
 * for multi-process deploys, a Redis or SQLite-backed implementation should
 * be supplied instead (interface is the same).
 *
 * Keyed by (embeddingFingerprint, toolName, descriptionHash) so changing a
 * model or a tool description naturally selects a different cache entry.
 */
import type { ToolEmbeddingStore } from './stages.js';

export class InMemoryToolEmbeddingStore implements ToolEmbeddingStore {
  private map = new Map<string, Float32Array>();
  private key(toolName: string, hash: string, fingerprint: string): string {
    return JSON.stringify([fingerprint, toolName, hash]);
  }
  get(toolName: string, hash: string, fingerprint: string): Float32Array | undefined {
    return this.map.get(this.key(toolName, hash, fingerprint));
  }
  set(toolName: string, hash: string, fingerprint: string, embedding: Float32Array): void {
    this.map.set(this.key(toolName, hash, fingerprint), embedding);
  }
  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}
