/**
 * Completion context — compact, $0 project knowledge injected into the
 * autocomplete prompt: exported signatures from the files the current
 * file imports (structural index: file_dependencies + symbols). Fail-open
 * by design — any store hiccup degrades to "no context", never an error.
 *
 * Module-level caches on purpose: `createEditorHandlers` is instantiated
 * twice on Electron (IPC mount + Hono dispatch fallback) and the caches
 * must be shared across both instances.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBSymbol } from '@mcp/shared/types.js';

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

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: performance.now() + this.ttlMs });
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

const MAX_IMPORTS = 5;
const MAX_SYMBOLS_PER_FILE = 12;

// Context is keyed per file and refreshed every 10s — imports don't churn
// keystroke-to-keystroke, and the watcher keeps the index itself fresh.
const contextCache = new TtlLru<string>(64, 10_000);

function signatureLine(s: DBSymbol): string {
  const sig = (s.signature ?? '').trim();
  if (sig.length > 0) return sig.length > 160 ? `${sig.slice(0, 160)}…` : sig;
  return `${s.kind} ${s.name}`;
}

/**
 * Render "// path" + exported signatures for the top imported files of
 * `file`, capped at `budgetChars`. Empty string when nothing useful.
 */
export function buildImportContext(
  db: CodeIndexDB,
  projectId: number,
  file: string,
  budgetChars: number,
): string {
  if (budgetChars <= 0) return '';
  const cacheKey = `${projectId}:${file}`;
  const cached = contextCache.get(cacheKey);
  if (cached !== undefined) return cached.slice(0, budgetChars);

  let block = '';
  try {
    const fileRow = db.getFile(projectId, file);
    if (!fileRow) {
      contextCache.set(cacheKey, '');
      return '';
    }
    const imported: string[] = [];
    for (const d of db.getDependencies(fileRow.id)) {
      if (d.target_file_path && d.target_file_path !== file) imported.push(d.target_file_path);
      if (imported.length >= MAX_IMPORTS) break;
    }
    const parts: string[] = [];
    let used = 0;
    for (const dep of imported) {
      const symbols = db
        .getSymbolsByFile(projectId, dep)
        .filter((s) => s.exported === 1)
        .slice(0, MAX_SYMBOLS_PER_FILE);
      if (symbols.length === 0) continue;
      const section = [`// ${dep}`, ...symbols.map(signatureLine)].join('\n');
      if (used + section.length + 2 > budgetChars) break;
      parts.push(section);
      used += section.length + 2;
    }
    block = parts.join('\n\n');
  } catch {
    block = '';
  }
  contextCache.set(cacheKey, block);
  return block;
}
