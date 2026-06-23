/**
 * UI state that survives the iframe's remounts (switching rail panels or the
 * app locale recreates the webview): the navigation stack persists in the
 * plugin's KV storage, debounced. Volatile caches (list rows, account info,
 * project detection) stay in module memory — cheap to refetch, never stale
 * across reloads.
 */
import { mcp } from './mcp.js';

export interface Frame {
  view: string;
  /** JSON-safe, string-valued params so the stack can persist. */
  params: Record<string, string>;
}

const KEY = 'ui.state.v1';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadStack(): Promise<Frame[] | null> {
  try {
    const raw = await mcp.storage.get(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { stack?: Frame[] };
    if (!Array.isArray(parsed.stack) || !parsed.stack.length) return null;
    return parsed.stack.filter(
      (f): f is Frame => !!f && typeof f.view === 'string' && typeof f.params === 'object',
    );
  } catch {
    return null;
  }
}

export function saveStack(stack: Frame[]): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void mcp.storage.set(KEY, JSON.stringify({ stack })).catch(() => {});
  }, 150);
}

/** Account info from cf_whoami, cached per mount. */
export interface AccountInfo {
  rows: Array<{ id: string; name: string; selected: boolean }>;
  selected: string | null;
}

/** Project detection from cf_detect, cached per mount. */
export interface DetectInfo {
  isCloudflare: boolean;
  deployKind: 'opennext' | 'pages' | 'worker' | null;
  workerName?: string;
  configPath?: string;
}

interface VolatileCache {
  rows: Map<string, unknown[]>;
  /** undefined = not fetched yet; null = cf_whoami failed (no usable token). */
  account: AccountInfo | null | undefined;
  detect: DetectInfo | null;
}

export const cache: VolatileCache = { rows: new Map(), account: undefined, detect: null };

/** Drop list caches (e.g. after switching the target account). */
export function invalidateRows(prefix?: string): void {
  if (!prefix) {
    cache.rows.clear();
    return;
  }
  for (const k of [...cache.rows.keys()]) if (k.startsWith(prefix)) cache.rows.delete(k);
}
