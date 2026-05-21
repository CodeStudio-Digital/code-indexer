/**
 * In-memory MessageEmbeddingStore. Sessions are usually < 1000 messages so
 * a Map works. For multi-process deploys, swap for a SQLite-backed impl
 * that uses (session_id, message_id) as the composite key.
 */
import type { MessageEmbeddingStore } from './stages.js';

export class InMemoryMessageEmbeddingStore implements MessageEmbeddingStore {
  private map = new Map<string, Float32Array>();
  get(id: string): Float32Array | undefined { return this.map.get(id); }
  set(id: string, embedding: Float32Array): void { this.map.set(id, embedding); }
  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  delete(id: string): void { this.map.delete(id); }
}
