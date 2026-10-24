import type { ToolSourceTruncation } from '@mcp/code-agent/core/tool.js';

interface Entry { at: number; text: string; sourceTruncations?: ToolSourceTruncation[]; bytes: number }
const cache = new Map<string, Entry>();
let bytes = 0;
const remove = (key: string) => { const entry = cache.get(key); if (entry) bytes -= entry.bytes; cache.delete(key); };
export function webCacheGet(key: string): Entry | undefined {
  const entry = cache.get(key);
  if (!entry) return;
  if (Date.now() - entry.at > 15 * 60 * 1000) { remove(key); return; }
  cache.delete(key); cache.set(key, entry); return entry;
}
export function webCachePut(key: string, text: string, sourceTruncations?: ToolSourceTruncation[]): void {
  const size = Buffer.byteLength(text);
  if (text.length > 1000000 || size > 2 * 1024 * 1024) return;
  remove(key); bytes += size;
  cache.set(key, { at: Date.now(), text, sourceTruncations, bytes: size });
  while (bytes > 8 * 1024 * 1024 || cache.size > 50) remove(cache.keys().next().value!);
}
