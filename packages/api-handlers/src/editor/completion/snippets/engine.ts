/**
 * Context Engine v2 orchestrator — replaces buildLayeredContext when the
 * `context_engine` knob is 'v2' (default). Gathers stable sources in parallel
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
import { ensureTracking } from './edit-tracker.js';
import { recentEditSnippets } from './source-recent-edits.js';
import { openTabSnippets } from './source-open-tabs.js';
import { lspDefSnippets } from './source-lsp-defs.js';
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
  siblings: 6,
  imports: 7,
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
/** Version distance that forces a rebuild even inside the TTL (big paste/refactor). */
const VERSION_JUMP = 50;

function cacheGet(key: string, ttlMs: number, docVersion: number): StableEntry | null {
  const hit = stableCache.get(key);
  if (!hit) return null;
  if (performance.now() - hit.builtAt > ttlMs || docVersion - hit.builtVersion >= VERSION_JUMP) {
    stableCache.delete(key);
    return null;
  }
  stableCache.delete(key); // refresh recency
  stableCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, entry: StableEntry): void {
  if (stableCache.has(key)) stableCache.delete(key);
  stableCache.set(key, entry);
  if (stableCache.size > STABLE_CACHE_CAP) {
    const oldest = stableCache.keys().next().value;
    if (oldest !== undefined) stableCache.delete(oldest);
  }
}

/** Test hook — the cache is module state. */
export function __clearStableCacheForTests(): void {
  stableCache.clear();
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
    const regionKey = regionKeyFor(projectId, file, syms, position.line);
    const enclosing = enclosingClass(syms, position.line);

    // Volatile sources start immediately (concurrent with the stable gather).
    const volatileP = memberSnippets(input, syms, doc?.content);

    // Stable block: cache hit skips every stable source.
    let stableSnips: ContextSnippet[];
    let sources: Record<string, SourceStats> = {};
    let stableCacheHit = false;
    const cached = cacheGet(regionKey, input.cacheTtlMs, docVersion);
    if (cached) {
      stableSnips = cached.snips;
      sources = { ...cached.sources };
      stableCacheHit = true;
    } else {
      const EMPTY_RACE = { v: [] as ContextSnippet[], ms: 0, timedOut: true, error: false };
      const gather = Promise.all([
        raceSource(() => siblingSnippets(db, projectId, syms, enclosing, file), input.sourceTimeoutMs, []),
        raceSource(() => importSnippets(db, projectId, file), input.sourceTimeoutMs, []),
        input.toggles.recentEdits
          ? raceSource(() => recentEditSnippets(input), input.sourceTimeoutMs, [])
          : Promise.resolve(EMPTY_RACE),
        input.toggles.openTabs
          ? raceSource(() => openTabSnippets(input), input.sourceTimeoutMs, [])
          : Promise.resolve(EMPTY_RACE),
        input.toggles.lspDefs
          ? raceSource(() => lspDefSnippets(input), input.sourceTimeoutMs, [])
          : Promise.resolve(EMPTY_RACE),
      ]);
      // Global deadline over the whole stable gather (belt over the per-source boxes).
      const all = await raceSource(() => gather, input.deadlineMs + 50, null);
      const [sib, imp, edits, tabs, defs] = all.v ?? [EMPTY_RACE, EMPTY_RACE, EMPTY_RACE, EMPTY_RACE, EMPTY_RACE];
      stableSnips = [markerSnippet(file, input.language), ...edits.v, ...defs.v, ...tabs.v, ...sib.v, ...imp.v];
      sources = {
        siblings: statsOf(sib.v, sib),
        imports: statsOf(imp.v, imp),
        edits: statsOf(edits.v, edits),
        tabs: statsOf(tabs.v, tabs),
        lspDefs: statsOf(defs.v, defs),
      };
      cacheSet(regionKey, { snips: stableSnips, builtVersion: docVersion, builtAt: performance.now(), sources });
    }

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
