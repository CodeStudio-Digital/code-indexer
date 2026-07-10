/**
 * find-tools-score — pure lexical scorer behind `find_tools` (see find-tools.ts
 * for the tool wrapper and the two-pass model rationale).
 *
 * Design constraints:
 *  - Zero imports from registry/tiers so it unit-tests in isolation and stays
 *    the cheap path (no vector store, no embeddings).
 *  - Per token, take the BEST field hit (max), never a sum — summing rewards
 *    redundancy ("agent" hitting name AND description) instead of coverage.
 *  - Three searchable fields per tool: name parts, TOP-LEVEL parameter names,
 *    and description words. Param descriptions are a weak fourth signal.
 */

export type ToolLike = { name: string; description?: string; parameters?: unknown };

/**
 * Filler words dropped from queries. Kept deliberately small — anything that
 * is a meaningful name part in the catalog ("file", "run", "list") must stay
 * out. Known acceptable loss: "for" is a part of wait_for_compile_clean; its
 * siblings ("wait", "compile") carry the match.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'and', 'or',
  'is', 'are', 'be', 'do', 'does', 'how', 'what', 'that', 'this', 'it', 'my',
  'me', 'we', 'you', 'need', 'want', 'use', 'using', 'tool', 'tools',
  'please', 'can', 'some', 'any',
]);

const MAX_TOKENS = 12; // paste-a-paragraph guard
const PREFIX_MIN = 3; // min token/part length for name+param prefix matches
// A token EXTENDING a part ("agents"→"agent") only means morphology when the
// part is long enough — "approval"→"app" is coincidence, not a match.
const EXTEND_MIN = 4;
const DESC_PREFIX_MIN = 4; // min length for desc-word prefixes (create→creates)
const DESC_WORD_CAP = 500; // caps guard tools with inlined examples in descs
const PARAM_DESC_WORD_CAP = 300;

/**
 * Lowercase, split on non-alphanumerics (underscores too, so "evolution_id"
 * → ["evolution","id"], same shape as name parts), dedup, drop stopwords.
 * An all-stopword query falls back to the deduped raw tokens rather than
 * erroring — best effort beats a wall.
 */
export function tokenizeQuery(query: string): string[] {
  const deduped = [
    ...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)),
  ];
  const kept = deduped.filter((t) => !STOPWORDS.has(t));
  return (kept.length > 0 ? kept : deduped).slice(0, MAX_TOKENS);
}

export interface ParamInfo {
  name: string;
  parts: string[];
  required: boolean;
  typeLabel: string;
  descWords: string[];
}

/**
 * Top-level parameters only — deliberately NO recursion. Nested schemas (e.g.
 * App Studio's spec body) are arbitrarily large and full of generic words
 * ("id", "name", "type") that would make every tool match everything.
 * Narrowing is defensive: `properties` values are unknown at the type level.
 */
export function topLevelParams(parameters: unknown): ParamInfo[] {
  const schema = parameters as { properties?: unknown; required?: unknown } | null | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((r): r is string => typeof r === 'string')
      : [],
  );
  const out: ParamInfo[] = [];
  for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
    const v = (value && typeof value === 'object' ? value : {}) as {
      type?: unknown;
      description?: unknown;
    };
    const t = v.type;
    out.push({
      name,
      parts: splitParts(name),
      required: required.has(name),
      typeLabel: Array.isArray(t) ? t.join('|') : typeof t === 'string' ? t : 'any',
      descWords:
        typeof v.description === 'string' ? uniqueWords(v.description, PARAM_DESC_WORD_CAP) : [],
    });
  }
  return out;
}

function splitParts(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function uniqueWords(text: string, cap: number): string[] {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 2) seen.add(w);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

/** Pre-split, deduped, capped text bundle for one tool. */
export interface ToolText {
  name: string;
  nameParts: string[];
  params: ParamInfo[];
  descWords: string[];
  descWordSet: Set<string>;
  paramDescWords: string[];
  paramDescWordSet: Set<string>;
}

// Keyed by tool object identity: registry.list() returns stable refs, and a
// re-registration is a new object — natural invalidation, no TTL needed.
const textCache = new WeakMap<ToolLike, ToolText>();

export function getToolText(tool: ToolLike): ToolText {
  const cached = textCache.get(tool);
  if (cached) return cached;
  const params = topLevelParams(tool.parameters);
  const paramDescWordSet = new Set<string>();
  for (const p of params) {
    for (const w of p.descWords) {
      if (paramDescWordSet.size >= PARAM_DESC_WORD_CAP) break;
      paramDescWordSet.add(w);
    }
  }
  const descWords = uniqueWords(tool.description ?? '', DESC_WORD_CAP);
  const text: ToolText = {
    name: tool.name.toLowerCase(),
    nameParts: splitParts(tool.name),
    params,
    descWords,
    descWordSet: new Set(descWords),
    paramDescWords: [...paramDescWordSet],
    paramDescWordSet,
  };
  textCache.set(tool, text);
  return text;
}

export interface TokenHit {
  weight: number;
  field: 'name' | 'param' | 'desc' | 'param-desc';
  /** Param name behind the hit when field === 'param'. */
  param?: string;
}

function partPrefix(token: string, parts: string[]): boolean {
  if (token.length < PREFIX_MIN) return false;
  return parts.some(
    (p) =>
      (p.length >= PREFIX_MIN && p.startsWith(token)) ||
      (p.length >= EXTEND_MIN && token.startsWith(p)),
  );
}

function wordHit(token: string, set: Set<string>, list: string[]): boolean {
  if (set.has(token)) return true;
  if (token.length < DESC_PREFIX_MIN) return false;
  return list.some((w) => w.length >= DESC_PREFIX_MIN && (w.startsWith(token) || token.startsWith(w)));
}

/**
 * Best single field hit for a token, checked strongest-first:
 *   name part exact 5 > param part exact 4 > name part prefix 3 >
 *   name substring / param prefix+substring / description word 2 >
 *   param-description word 1.
 * Description matching is word-boundary by construction (descs are pre-split
 * into words), so "id" cannot hit "provide" — the false positive that forced
 * the old scorer's +1 weight and floors.
 */
export function bestHit(token: string, text: ToolText): TokenHit | null {
  if (text.nameParts.includes(token)) return { weight: 5, field: 'name' };
  const exact = text.params.find((p) => p.parts.includes(token));
  if (exact) return { weight: 4, field: 'param', param: exact.name };
  if (partPrefix(token, text.nameParts)) return { weight: 3, field: 'name' };
  if (token.length >= PREFIX_MIN && text.name.includes(token)) return { weight: 2, field: 'name' };
  const loose = text.params.find(
    (p) => partPrefix(token, p.parts) || (token.length >= PREFIX_MIN && p.name.includes(token)),
  );
  if (loose) return { weight: 2, field: 'param', param: loose.name };
  if (wordHit(token, text.descWordSet, text.descWords)) return { weight: 2, field: 'desc' };
  if (wordHit(token, text.paramDescWordSet, text.paramDescWords)) {
    return { weight: 1, field: 'param-desc' };
  }
  return null;
}

export interface ToolScore {
  total: number; // sum of per-token best weights
  hitCount: number; // distinct tokens with any hit
  /**
   * Some hit with weight >= 3 from a token of length >= 3. The length guard
   * keeps ubiquitous 2-char param parts ("id" is in half the catalog) from
   * single-handedly qualifying a tool as a strong match — they still score.
   */
  hasAnchor: boolean;
  bestWeight: number;
  matchedParams: string[];
  nameHit: boolean;
}

export function scoreTool(tokens: string[], text: ToolText): ToolScore {
  const s: ToolScore = {
    total: 0, hitCount: 0, hasAnchor: false, bestWeight: 0, matchedParams: [], nameHit: false,
  };
  for (const tok of tokens) {
    const hit = bestHit(tok, text);
    if (!hit) continue;
    s.total += hit.weight;
    s.hitCount += 1;
    s.bestWeight = Math.max(s.bestWeight, hit.weight);
    if (hit.weight >= 3 && tok.length >= 3) s.hasAnchor = true;
    if (hit.field === 'name') s.nameHit = true;
    if (hit.param && !s.matchedParams.includes(hit.param)) s.matchedParams.push(hit.param);
  }
  return s;
}

/**
 * Strong pass: enough coverage AND either an anchor hit or full coverage on a
 * >=3-token query. The full-coverage arm is what makes description-only
 * matches possible at all (the old scorer's threshold made them mathematically
 * unreachable) without resurrecting one-incidental-word false positives.
 */
export function passesStrict(s: ToolScore, tokenCount: number, coverage: number): boolean {
  if (s.hitCount < Math.ceil(tokenCount * coverage)) return false;
  return s.hasAnchor || (s.hitCount === tokenCount && tokenCount >= 3);
}

/**
 * Relaxed pass (only consulted when the strong pass is empty): half coverage,
 * OR one exact name/param hit — so a junk-heavy query still surfaces its one
 * real anchor as a "closest candidate" instead of dead-ending.
 */
export function passesRelaxed(s: ToolScore, tokenCount: number, coverage: number): boolean {
  if (s.hitCount === 0) return false;
  return s.hitCount >= Math.max(1, Math.ceil(tokenCount * coverage)) || s.bestWeight >= 4;
}
