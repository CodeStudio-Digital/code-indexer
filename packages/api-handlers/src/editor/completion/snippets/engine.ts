/**
 * Context Engine v2/v3 orchestrator — replaces buildLayeredContext for both
 * snippet engines. v3 adds consent-gated FTS related-code retrieval and split
 * stable/dynamic revisions; v2 remains a kill-switch without related code.
 * Gathers stable sources in parallel
 * (each race-boxed, all under a global deadline) with a per-region cache so
 * the stable block stays byte-identical across keystrokes, runs the volatile
 * sources (scope/members) concurrently, then packs everything by priority
 * into the token budget. Fail-open: any source (or the whole engine) throwing
 * degrades to less context, never an error.
 */
import type { DBSymbol } from '@mcp/shared/types.js';
import { getDoc } from '../../../lsp/document-store.js';
import { enclosingClass } from '../../../lsp/fallback-members.js';
import {
  markerSnippet, scopeSnippet, memberSnippets, siblingSnippets, importSnippets,
} from './source-index.js';
import { contextRevision, ensureTracking } from './edit-tracker.js';
import { recentEditSnippets } from './source-recent-edits.js';
import { openTabSnippets } from './source-open-tabs.js';
import { lspDefSnippets } from './source-lsp-defs.js';
import { relatedCodeSnippets } from './source-related-code.js';
import {
  SNIPPET_OVERHEAD_TOK,
  type AssembledContext,
  type ContextSnippet,
  type EngineInput,
  type SourceStats,
} from './types.js';

const EMPTY_CONTEXT: AssembledContext = {
  stable: [], volatile: [], totalTokens: 0, stableCacheHit: false, regionKey: '',
  memberSource: 'none', memberTriggerHit: false, membersInjected: 0, inferSource: 'none', sources: {},
};

/** Packing priority per kind — lower packs first (survives tight budgets). */
const KIND_PRIORITY: Record<ContextSnippet['kind'], number> = {
  marker: 0,
  members: 1,
  scope: 2,
  'recent-edit': 3,
  'lsp-def': 4,
  'open-tab': 5,
  'related-code': 6,
  siblings: 7,
  imports: 8,
};

// ── Stable-region cache (module-level: Electron dual-factory) ─────────────
interface StableEntry {
  snips: ContextSnippet[];
  builtVersion: number;
  builtAt: number;
  sources: Record<string, SourceStats>;
}
const STABLE_CACHE_CAP = 32;
const stableCache = new Map<string, StableEntry>();
const dynamicCache = new Map<string, StableEntry>();
/** Version distance that forces a rebuild even inside the TTL (big paste/refactor). */
const VERSION_JUMP = 50;

function cacheGet(cache: Map<string, StableEntry>, key: string, ttlMs: number, docVersion: number): StableEntry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (performance.now() - hit.builtAt > ttlMs || docVersion - hit.builtVersion >= VERSION_JUMP) {
    cache.delete(key);
    return null;
  }
  cache.delete(key); // refresh recency
  cache.set(key, hit);
  return hit;
}

function cacheSet(cache: Map<string, StableEntry>, key: string, entry: StableEntry): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  if (cache.size > STABLE_CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Test hook — the cache is module state. */
export function __clearStableCacheForTests(): void {
  stableCache.clear();
  dynamicCache.clear();
}

/** Region identity: file + innermost enclosing container (or a 40-line bucket). */
function regionKeyFor(projectId: number, file: string, syms: DBSymbol[], line: number): string {
  const enclosing = enclosingClass(syms, line);
  const anchor = enclosing ?? `b${Math.floor(line / 40) * 40}`;
  return `${projectId}:${file}:${anchor}`;
}

/** Race a source against its time box; timeouts/errors yield the empty value. */
async function raceSource<T>(
  fn: () => Promise<T> | T,
  ms: number,
  empty: T,
): Promise<{ v: T; ms: number; timedOut: boolean; error: boolean }> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const SENTINEL = Symbol('src-timeout');
  try {
    const raced = await Promise.race([
      Promise.resolve().then(fn),
      new Promise<typeof SENTINEL>((r) => { timer = setTimeout(() => r(SENTINEL), ms); }),
    ]);
    const elapsed = performance.now() - started;
    if (raced === SENTINEL) return { v: empty, ms: elapsed, timedOut: true, error: false };
    return { v: raced as T, ms: elapsed, timedOut: false, error: false };
  } catch {
    return { v: empty, ms: performance.now() - started, timedOut: false, error: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function statsOf(snips: ContextSnippet[], r: { ms: number; timedOut: boolean; error: boolean }): SourceStats {
  return {
    n: snips.length,
    tokens: snips.reduce((t, s) => t + s.tokens, 0),
    ms: Math.round(r.ms),
    ...(r.timedOut ? { timedOut: true } : {}),
    ...(r.error ? { error: true } : {}),
  };
}

/** Pack by kind priority (stable ordering within a kind by source score). */
export function packByPriority(snips: ContextSnippet[], budgetTokens: number): ContextSnippet[] {
  const ordered = [...snips].sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || b.score - a.score,
  );
  const out: ContextSnippet[] = [];
  let used = 0;
  for (const s of ordered) {
    const cost = s.tokens + SNIPPET_OVERHEAD_TOK;
    if (used + cost > budgetTokens) continue; // smaller later snippets may still fit
    out.push(s);
    used += cost;
  }
  return out;
}

/** Render snippets as markdown sections (chat path; FIM commentizes this). */
export function renderSnippetSections(snips: ContextSnippet[]): string {
  const parts: string[] = [];
  for (const s of snips) {
    switch (s.kind) {
      case 'marker': parts.push(s.content); break;
      case 'scope': parts.push(`### Scope\n${s.content}`); break;
      case 'members': parts.push(`### ${s.content}`); break; // 1st line = "Members of X:"
      case 'recent-edit': parts.push(`### Recently edited: ${s.filePath}\n${s.content}`); break;
      case 'lsp-def': parts.push(`### Definition: ${s.filePath}\n${s.content}`); break;
      case 'open-tab': parts.push(`### From open file: ${s.filePath}\n${s.content}`); break;
      case 'related-code': parts.push(`### Similar code: ${s.filePath}\n${s.content}`); break;
      case 'siblings': parts.push(`### Current class & file\n${s.content}`); break;
      case 'imports': parts.push(`### Imported APIs\n${s.content}`); break;
    }
  }
  return parts.join('\n\n');
}

export async function assembleContext(input: EngineInput): Promise<AssembledContext> {
  try {
    ensureTracking(); // idempotent doc-event subscription for recent-edits
    const { db, projectId, file, position } = input;
    let syms: DBSymbol[] = [];
    try { syms = db.getSymbolsByFile(projectId, file); } catch { syms = []; }
    const doc = getDoc(projectId, file);
    const docVersion = doc?.version ?? 0;
    const revision = contextRevision(projectId);
    const windowKey = input.windows.prefix.slice(-300).replace(/\s+/g, ' ').slice(-120);
    const regionKey = regionKeyFor(projectId, file, syms, position.line);
    const dynamicKey = `${regionKey}:r${revision}:w${windowKey}`;
    const enclosing = enclosingClass(syms, position.line);

    // Volatile sources start immediately (concurrent with the stable gather).
    const volatileP = memberSnippets(input, syms, doc?.content);

    // Imports/symbols use the long stable cache. Cursor-sensitive cross-file
    // sources have their own revision and a short cache so they never freeze
    // for the old 10-second window.
    const EMPTY_RACE = { v: [] as ContextSnippet[], ms: 0, timedOut: true, error: false };
    const staticCached = cacheGet(stableCache, regionKey, input.cacheTtlMs, docVersion);
    const dynamicCached = cacheGet(dynamicCache, dynamicKey, Math.min(input.cacheTtlMs, 1_500), docVersion);
    const staticGather = staticCached ? Promise.resolve(null) : raceSource(() => Promise.all([
        raceSource(() => siblingSnippets(db, projectId, syms, enclosing, file), input.sourceTimeoutMs, []),
        raceSource(() => importSnippets(db, projectId, file), input.sourceTimeoutMs, []),
      ]), input.deadlineMs + 50, null);
    const dynamicGather = dynamicCached ? Promise.resolve(null) : raceSource(() => Promise.all([
        input.toggles.recentEdits
          ? raceSource(() => recentEditSnippets(input), input.sourceTimeoutMs, [])
          : Promise.resolve(EMPTY_RACE),
        input.toggles.openTabs
          ? raceSource(() => openTabSnippets(input), input.sourceTimeoutMs, [])
          : Promise.resolve(EMPTY_RACE),
        input.toggles.lspDefs
          ? raceSource(() => lspDefSnippets(input), input.sourceTimeoutMs, [])
          : Promise.resolve(EMPTY_RACE),
        input.toggles.relatedCode
          ? raceSource(() => relatedCodeSnippets(input), input.sourceTimeoutMs, [])
          : Promise.resolve(EMPTY_RACE),
      ]), input.deadlineMs + 50, null);
    const [staticResult, dynamicResult] = await Promise.all([staticGather, dynamicGather]);
    const [sib, imp] = staticResult?.v ?? [EMPTY_RACE, EMPTY_RACE];
    const [edits, tabs, defs, related] = dynamicResult?.v ?? [EMPTY_RACE, EMPTY_RACE, EMPTY_RACE, EMPTY_RACE];
    const staticEntry = staticCached ?? {
      snips: [...sib.v, ...imp.v], builtVersion: docVersion, builtAt: performance.now(),
      sources: { siblings: statsOf(sib.v, sib), imports: statsOf(imp.v, imp) },
    };
    const dynamicEntry = dynamicCached ?? {
      snips: [...edits.v, ...defs.v, ...tabs.v, ...related.v], builtVersion: docVersion, builtAt: performance.now(),
      sources: {
        edits: statsOf(edits.v, edits), tabs: statsOf(tabs.v, tabs),
        lspDefs: statsOf(defs.v, defs), related: statsOf(related.v, related),
      },
    };
    if (!staticCached) cacheSet(stableCache, regionKey, staticEntry);
    if (!dynamicCached) cacheSet(dynamicCache, dynamicKey, dynamicEntry);
    const stableSnips = [markerSnippet(file, input.language), ...dynamicEntry.snips, ...staticEntry.snips];
    const sources: Record<string, SourceStats> = { ...staticEntry.sources, ...dynamicEntry.sources };
    const stableCacheHit = !!staticCached && !!dynamicCached;

    const mem = await volatileP;
    const volatileSnips: ContextSnippet[] = [];
    const scope = scopeSnippet(syms, position.line);
    if (mem.snippet) volatileSnips.push(mem.snippet);
    if (scope) volatileSnips.push(scope);
    sources.members = {
      n: mem.snippet ? 1 : 0,
      tokens: mem.snippet?.tokens ?? 0,
      ms: 0,
    };

    const packed = packByPriority([...stableSnips, ...volatileSnips], input.budgetTokens);
    const packedSet = new Set(packed);
    const stable = stableSnips.filter((s) => packedSet.has(s));
    const volatilePacked = volatileSnips.filter((s) => packedSet.has(s));
    return {
      stable,
      volatile: volatilePacked,
      totalTokens: packed.reduce((t, s) => t + s.tokens + SNIPPET_OVERHEAD_TOK, 0),
      stableCacheHit,
      regionKey,
      memberSource: mem.raw.source,
      memberTriggerHit: mem.raw.triggered,
      membersInjected: mem.raw.count,
      inferSource: mem.raw.inferSource,
      sources,
    };
  } catch {
    return { ...EMPTY_CONTEXT };
  }
}
