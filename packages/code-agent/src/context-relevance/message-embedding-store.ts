/**
 * In-memory MessageEmbeddingStore. Sessions are usually < 1000 messages so
 * a Map works. For multi-process deploys, swap for a SQLite-backed impl
 * that uses (session_id, message_id) as the composite key.
 */
import type { MessageEmbeddingStore } from './stages.js';

export class InMemoryMessageEmbeddingStore implements MessageEmbeddingStore {
  private map = new Map<string, Float32Array>();
  private key(id: string, fingerprint: string): string { return JSON.stringify([fingerprint, id]); }
  get(id: string, fingerprint: string): Float32Array | undefined { return this.map.get(this.key(id, fingerprint)); }
  set(id: string, fingerprint: string, embedding: Float32Array): void {
    this.map.set(this.key(id, fingerprint), embedding);
  }
  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  delete(id: string): void {
    for (const key of this.map.keys()) {
      const parsed = JSON.parse(key) as [string, string];
      if (parsed[1] === id) this.map.delete(key);
    }
  }
}
