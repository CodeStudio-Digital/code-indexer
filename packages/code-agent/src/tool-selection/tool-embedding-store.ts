/**
 * In-memory ToolEmbeddingStore.
 *
 * Tools change rarely — the embedding for "Read: reads a file at a path"
 * is the same across thousands of sessions. A small Map in process is fine;
 * for multi-process deploys, a Redis or SQLite-backed implementation should
 * be supplied instead (interface is the same).
 *
 * Keyed by (toolName, descriptionHash) so that updating a tool's
 * description naturally invalidates its cache entry.
 */
import type { ToolEmbeddingStore } from './stages.js';

export class InMemoryToolEmbeddingStore implements ToolEmbeddingStore {
  private map = new Map<string, Float32Array>();
  private key(toolName: string, hash: string): string { return `${toolName}::${hash}`; }
  get(toolName: string, hash: string): Float32Array | undefined {
    return this.map.get(this.key(toolName, hash));
  }
  set(toolName: string, hash: string, embedding: Float32Array): void {
    this.map.set(this.key(toolName, hash), embedding);
  }
  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}
