/**
 * LLM-assisted link extractor — surfaces URLs that the cheerio
 * `a[href]` pass missed because they live in non-anchor structures:
 *
 *   - `data-*` attributes (data-href, data-route)
 *   - Embedded JSON page maps (`__NEXT_DATA__`, `__INITIAL_STATE__`,
 *     `pageMap`, tree-view arrays)
 *   - URL string literals inside `<script>` bodies
 *   - `<area href>` in image maps, `<form action>`
 *
 * Called ONCE per source (seed page, depth=0) when the source has
 * `crawl_llm_extract_links = 1`. Result is unioned with cheerio links
 * by the crawler; `required_path` filter scopes the frontier downstream.
 *
 * Anti-hallucination contract (prompt-enforced): the LLM MUST return
 * only URLs that LITERALLY appear in the HTML. No path inference from
 * prose ("see also the Camera class" → `/api/Camera.html` is forbidden).
 *
 * Degrades silently:
 *   - No `link_extractor` binding configured  →  []
 *   - LLM request fails / times out           →  [] (with warn log)
 *   - LLM response not parseable as JSON      →  [] (with warn log)
 *   - URL doesn't resolve via `new URL(href, baseUrl)` →  filtered out
 */
import type { PipelineProviderResolver } from '../../pipelines/index.js';
import { pickChatFn } from '../../quality/chat-dispatcher.js';

export interface LinkExtractorOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: { sessionId?: string; companySessionId?: string; templateId?: number };
  /**
   * Cap on input HTML size sent to the LLM. Default 30000 chars
   * (~7500 tokens) — fits most pages comfortably below model context
   * limits. Larger pages get truncated by `truncateHtml` which keeps
   * `<script>` blocks at the front (URLs are usually in there).
   */
  maxInputChars?: number;
}

export interface ExtractedLink {
  url: string;
  /** Short human-readable diagnostic of where the LLM found this URL. */
  reason: string;
}

const DEFAULT_MAX_INPUT_CHARS = 30_000;

/**
 * Run the LLM on raw HTML and return links it found. Same-origin
 * filtering is left to the caller (the crawler already does it).
 */
export async function extractLinksWithLLM(
  baseUrl: string,
  rawHtml: string,
  opts: LinkExtractorOptions,
): Promise<ExtractedLink[]> {
  const binding = await opts.resolver.resolveOrNull(
    'doc_ingest',
    'link_extractor',
    opts.resolveContext ?? {},
  );
  if (!binding) {
    // No binding wired — silent fallback. The crawler still has cheerio.
    return [];
  }

  const maxChars = opts.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const truncated = truncateHtml(rawHtml, maxChars);
  const chat = pickChatFn(binding);

  let response;
  try {
    response = await chat(binding, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(baseUrl, truncated) },
    ]);
  } catch (err) {
    console.warn(
      `[doc-indexer] link-extractor LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  if (response.errorBody) {
    console.warn(
      `[doc-indexer] link-extractor LLM returned error: ${response.errorBody.slice(0, 200)}`,
    );
    return [];
  }

  const parsed = parseResponse(response.content);
  if (parsed.length === 0) return [];

  // Resolve every URL against the base. Drop ones that fail to parse
  // (typos, malformed JSON, anchors-only, etc).
  const resolved: ExtractedLink[] = [];
  for (const item of parsed) {
    try {
      const u = new URL(item.url, baseUrl);
      u.hash = '';
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      resolved.push({ url: u.toString(), reason: item.reason });
    } catch {
      /* unparseable URL — skip */
    }
  }
  return resolved;
}

/**
 * Trim HTML to roughly `maxChars`. Preserves `<script>` blocks at the
 * front (where embedded URL data typically lives) and follows with as
 * much body as fits. Crude but predictable.
 */
function truncateHtml(html: string, maxChars: number): string {
  if (html.length <= maxChars) return html;
  // Extract <script>...</script> blocks (greedy across whole doc).
  const scriptRe = /<script[\s\S]*?<\/script>/gi;
  const scripts: string[] = [];
  let scriptBudget = Math.floor(maxChars * 0.6);
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const piece = m[0];
    if (piece.length > scriptBudget) {
      // Single huge script — take what we can.
      scripts.push(piece.slice(0, scriptBudget));
      scriptBudget = 0;
      break;
    }
    scripts.push(piece);
    scriptBudget -= piece.length;
    if (scriptBudget <= 0) break;
  }
  // Body without scripts, capped to remaining budget.
  const bodyWithoutScripts = html.replace(scriptRe, '');
  const bodyBudget = Math.max(0, maxChars - scripts.reduce((a, b) => a + b.length, 0));
  const bodyTrimmed = bodyWithoutScripts.slice(0, bodyBudget);
  return [...scripts, '\n<!-- body excerpt -->\n', bodyTrimmed].join('\n');
}

const SYSTEM_PROMPT = `You extract outbound URLs from a documentation page so a web crawler can follow them.

Another extractor already collected visible <a href> links. Your job is to find URLs that THAT extractor MISSED — URLs that exist LITERALLY in the HTML but not as plain <a href> elements.

Look in:
- data-* attributes containing paths or URLs (data-href, data-route, data-link, etc.)
- Embedded JSON in <script> tags (window.__NEXT_DATA__, window.__INITIAL_STATE__, pageMap, treeData, navigation arrays)
- URL string literals inside <script> bodies (e.g. goto('/api/Camera'), navigate('/...'))
- <area href> in image maps
- <form action> if it points to another page

Hard rules — non-negotiable:
- ONLY return URLs that LITERALLY appear in the HTML. Do NOT invent or infer URLs from prose like "see also the Camera class".
- Relative URLs are fine — caller resolves them against the base URL.
- Skip fragments (#section), mailto:, javascript:, tel:.
- Skip URLs you also see as plain <a href> (those are already extracted).
- Max 200 URLs. If you find none, return [].

Respond ONLY with a JSON array, each item shaped like:
[{"url": "...", "reason": "<one short phrase saying where you found it>"}]

No prose. No markdown fences. Just the JSON.`;

function buildUserPrompt(baseUrl: string, html: string): string {
  return `Base URL: ${baseUrl}\n\nHTML:\n${html}`;
}

interface RawLinkItem { url?: unknown; reason?: unknown }

function parseResponse(text: string): ExtractedLink[] {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtractedLink[] = [];
  for (const item of parsed.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as RawLinkItem;
    if (typeof raw.url !== 'string') continue;
    const url = raw.url.trim();
    if (!url) continue;
    if (url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('tel:')) continue;
    const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 120) : 'llm';
    out.push({ url, reason });
  }
  return out;
}

function stripFences(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}
