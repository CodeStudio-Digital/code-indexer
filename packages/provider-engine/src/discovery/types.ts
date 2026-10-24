import type { UpsertModelInput } from '@mcp/store/provider-store.js';
export interface DiscoveryResult {
  models: UpsertModelInput[];
  /** Catalog ETag (chatgpt/codex only), or null. */
  etag: string | null;
  /** True on HTTP 304 — `models` is empty and existing rows are kept. */
  notModified: boolean;
}
