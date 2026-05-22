/**
 * URL crawler — BFS frontier expansion bounded by depth and page count.
 *
 * Composes `UrlFetcher` (polite HTTP with robots.txt + per-host throttle) +
 * `discoverFromSitemap` (best-effort seed expansion) + `convertHtmlToMarkdown`
 * (extract clean main content and same-origin links).
 *
 * The crawler emits `RawPage` ready for the relevance gate. It does NOT
 * call any LLM; it only fetches, parses, and queues. Pages with
 * `noindex` set in their meta are dropped before they reach the gate.
 *
 * Politeness defaults are intentionally conservative:
 *   - `crawl_enabled=false` → only the seed URL is fetched
 *   - `max_pages=200`, `max_depth=3` clamps are enforced
 *   - `same_origin=true` is the default
 */
import type { DocCrawlConfig } from '@mcp/store/doc-store.js';
import type { RawPage } from './types.js';
import { UrlFetcher } from './url-fetcher.js';
import {
  PlainFetchBackend,
  type RenderBackend,
} from './render-backend.js';
import { discoverFromSitemap } from './sitemap.js';
import { convertHtmlToMarkdown } from './html-to-markdown.js';
import { extractLinksWithLLM } from './link-extractor.js';
import type { PipelineProviderResolver } from '../../pipelines/index.js';

export interface CrawlOptions {
  seedUrl: string;
  sourceId: number;
  crawl: DocCrawlConfig;
  /**
   * Underlying renderer. When omitted, a fresh `PlainFetchBackend` wrapping
   * a default `UrlFetcher` is used (preserves the original behavior for
   * unit tests and callers that don't need browser escalation).
   */
  renderer?: RenderBackend;
  /** Legacy alias for the plain-fetch path — keep tests working. */
  fetcher?: UrlFetcher;
  /**
   * When provided AND `crawl.llm_extract_links === true`, the crawler
   * calls the LLM link extractor on the seed page to union URLs cheerio
   * missed (JS-rendered nav, data-attrs, embedded JSON). Omit to keep
   * the seed cheerio-only — tests usually pass undefined.
   */
  linkExtractorResolver?: PipelineProviderResolver;
  /** Resolution context forwarded to the LLM extractor binding lookup. */
  resolveContext?: { sessionId?: number; companySessionId?: number; templateId?: number };
  /** Fired after each page is fetched (for SSE progress). */
  onPageFetched?: (info: { url: string; ok: boolean; reason?: string; totalFetched: number }) => void;
}

const HARD_MAX_PAGES = 1000;
const HARD_MAX_DEPTH = 8;

/**
 * Crawl from `seedUrl`. Returns the list of `RawPage`s for the relevance
 * gate. When `crawl.enabled === false`, only the seed page is fetched.
 */
export async function crawlUrl(opts: CrawlOptions): Promise<RawPage[]> {
  // Build the renderer:
  //   - explicit opts.renderer wins (production hands an EscalatingFetcher)
  //   - opts.fetcher (legacy) → wrap in PlainFetchBackend
  //   - otherwise → fresh UrlFetcher + PlainFetchBackend (tests)
  const fetcher = opts.fetcher ?? new UrlFetcher();
  const renderer: RenderBackend = opts.renderer ?? new PlainFetchBackend(fetcher);
  const crawl = opts.crawl;

  const maxPages = Math.min(crawl.max_pages ?? 1, HARD_MAX_PAGES);
  const maxDepth = Math.min(crawl.max_depth ?? 0, HARD_MAX_DEPTH);
  const sameOriginOnly = crawl.same_origin !== false;
  const includePattern = compilePattern(crawl.include_pattern);
  const excludePattern = compilePattern(crawl.exclude_pattern);
  // Literal substring the URL must contain. Null = no constraint.
  // Trimmed empty string also degrades to null (treat blank UI input as "off").
  const requiredPath = (crawl.required_path ?? '').trim() || null;
  // Per-source render-mode flags. Two opt-ins coexist:
  //   * `force_browser`     → every page (depth 0..N) via Chromium. Most
  //                           expensive. Required when the leaves
  //                           themselves are SPA-rendered.
  //   * `browser_seed_only` → ONLY the seed (depth === 0) via Chromium;
  //                           every discovered leaf goes plain. Sweet
  //                           spot for sites where the SIDEBAR/NAV is
  //                           JS-only but each leaf is plain HTML
  //                           (Unity ScriptReference, Algolia DocSearch).
  //   * neither             → all plain (existing default).
  // Priority: `force_browser` wins when both are set. Documented in the
  // dialog help text so toggling both isn't a footgun.
  // Sitemap discovery (below) ALWAYS uses the plain UrlFetcher — XML
  // doesn't need a browser.
  const forceBrowserAll = crawl.force_browser === true;
  const browserSeedOnly = crawl.browser_seed_only === true && !forceBrowserAll;

  // Fail loudly if the user-supplied seed isn't parseable as a URL — a
  // silent skip in the BFS loop used to produce "DONE 0 pages 3ms" with
  // no clue what went wrong (seen with bare hosts like `docs.example.com`
  // before the use-case started auto-prepending `https://`).
  if (!normalizeUrl(opts.seedUrl)) {
    throw new Error(
      `Invalid seed URL: "${opts.seedUrl}" — must be a parseable http(s) URL with a host`,
    );
  }

  // If a required_path is set, the seed itself must satisfy it — otherwise
  // we'd produce a crawl where the seed slips through but every follow-up
  // gets dropped, which is almost always a user typo (forgot a slash,
  // wrong manual version, etc.). Fail early with a clear message.
  if (requiredPath && !opts.seedUrl.includes(requiredPath)) {
    throw new Error(
      `Seed URL "${opts.seedUrl}" does not contain the required substring "${requiredPath}"`,
    );
  }

  // Frontier seed: just the seed, OR seed + sitemap entries (cuts crawl
  // depth dramatically on sites that publish one). Sitemap discovery always
  // uses the plain UrlFetcher — we don't want to spin up a browser for
  // robots.txt / sitemap.xml.
  const seedUrls = [opts.seedUrl];
  if (crawl.enabled && maxPages > 1) {
    try {
      const sitemapUrls = await discoverFromSitemap(opts.seedUrl, fetcher, { maxUrls: maxPages });
      // Sitemap URLs join the frontier at depth 0 (treated as seeds).
      for (const u of sitemapUrls) {
        if (seedUrls.length >= maxPages) break;
        if (!seedUrls.includes(u)) seedUrls.push(u);
      }
    } catch { /* no sitemap is fine */ }
  }

  const visited = new Set<string>();
  const frontier: Array<{ url: string; depth: number }> = seedUrls.map((u) => ({ url: u, depth: 0 }));
  const collected: RawPage[] = [];
  let pagesFetched = 0;

  while (frontier.length > 0 && pagesFetched < maxPages) {
    const next = frontier.shift()!;
    const normalized = normalizeUrl(next.url);
    if (!normalized) continue;
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    if (!matchesPattern(normalized, includePattern, true)) continue;
    if (matchesPattern(normalized, excludePattern, false)) continue;
    // Literal substring filter — `null` was normalized away above.
    if (requiredPath && !normalized.includes(requiredPath)) continue;

    let raw: Awaited<ReturnType<RenderBackend['render']>> | null = null;
    let reason: string | undefined;
    // Decide whether THIS specific fetch goes through Chromium.
    //   * `force_browser=true` → always.
    //   * `browser_seed_only=true` AND we're on a depth-0 URL (seed or
    //     sitemap-discovered entry that joins the frontier at depth 0) →
    //     just this one fetch via Chromium so the JS-rendered nav becomes
    //     visible to the cheerio link extractor downstream. Every
    //     follow-up at depth >= 1 goes through plain HTTP — the win that
    //     makes a 1000-page crawl finish in minutes instead of hours.
    const useBrowserForThisPage =
      forceBrowserAll || (browserSeedOnly && next.depth === 0);
    try {
      raw = await renderer.render(
        normalized,
        useBrowserForThisPage ? { forceBrowser: true } : undefined,
      );
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      opts.onPageFetched?.({ url: normalized, ok: false, reason, totalFetched: pagesFetched });
      continue;
    }

    pagesFetched++;
    if (raw.status >= 400 || !raw.contentType.includes('html')) {
      opts.onPageFetched?.({
        url: normalized,
        ok: false,
        reason: `status=${raw.status} contentType=${raw.contentType}${raw.blockedSignals ? ' signals=' + raw.blockedSignals.join(',') : ''}`,
        totalFetched: pagesFetched,
      });
      continue;
    }

    const converted = convertHtmlToMarkdown(raw.html, {
      baseUrl: raw.finalUrl,
      sameOriginOnly,
    });
    if (converted.noindex) {
      opts.onPageFetched?.({ url: normalized, ok: false, reason: 'noindex meta', totalFetched: pagesFetched });
      continue;
    }

    // LLM-assisted link extraction — runs ONCE per source, on the seed
    // page (`depth === 0`). Unions URLs cheerio missed (JS-rendered
    // sidebars, data-attrs, embedded JSON page maps) with the cheerio
    // set. The required_path / pattern filters apply downstream, so
    // any noise the LLM picks up gets dropped before the next fetch.
    // Silent fallback when no `link_extractor` binding is configured
    // OR the LLM call errors — the cheerio pass still produced its
    // links, so crawl behavior degrades gracefully to "cheerio only".
    // Always log the LLM extractor decision at depth=0 — silent "0 found"
    // and "no binding configured" were both indistinguishable from "flag
    // off" in earlier runs, which made debugging "only 1 page indexed"
    // impossible without DB queries. Now every path emits a line.
    if (next.depth === 0) {
      if (!crawl.llm_extract_links) {
        // Flag off — no LLM extractor attempt. Cheerio only.
        // (Intentionally silent — most sources don't need this.)
      } else if (!opts.linkExtractorResolver) {
        console.warn(
          `[doc-indexer] llm link-extractor: flag ON but no pipelineProviderResolver in deps — skipping (cheerio only)`,
        );
      } else {
        // Probe the binding first so we can give the user a specific
        // diagnostic when it's missing (vs "LLM ran and found 0").
        const binding = await opts.linkExtractorResolver.resolveOrNull(
          'doc_ingest',
          'link_extractor',
          opts.resolveContext ?? {},
        );
        if (!binding) {
          console.warn(
            `[doc-indexer] llm link-extractor: flag ON but NO binding configured for 'doc_ingest/link_extractor'. Go to Admin → Pipelines and configure it (recommended: a cheap model like Llama 3 8B). Crawler continues cheerio-only.`,
          );
        } else try {
          console.log(
            `[doc-indexer] llm link-extractor: invoking for seed ${raw.finalUrl} (html=${raw.html.length}B, cheerio_links=${converted.links.length}, model=${binding.modelId})`,
          );
          const llmLinks = await extractLinksWithLLM(raw.finalUrl, raw.html, {
            resolver: opts.linkExtractorResolver,
            resolveContext: opts.resolveContext,
          });
          if (llmLinks.length === 0) {
            console.warn(
              `[doc-indexer] llm link-extractor: LLM returned 0 URLs. Either the model couldn't find any non-anchor URLs in the HTML (truncation? JS-only nav with no embedded JSON?), or the LLM emitted unparseable JSON. Crawler continues cheerio-only.`,
            );
          } else {
            const seen = new Set(converted.links);
            let added = 0;
            for (const { url } of llmLinks) {
              const norm = normalizeUrl(url);
              if (!norm || seen.has(norm)) continue;
              if (sameOriginOnly) {
                try {
                  const linkOrigin = new URL(norm).origin;
                  const seedOrigin = new URL(raw.finalUrl).origin;
                  if (linkOrigin !== seedOrigin) continue;
                } catch { continue; }
              }
              converted.links.push(norm);
              seen.add(norm);
              added++;
            }
            console.log(
              `[doc-indexer] llm link-extractor: found ${llmLinks.length} candidates, ${added} new after dedup+same-origin`,
            );
          }
        } catch (err) {
          console.warn(
            `[doc-indexer] llm link-extractor failed: ${err instanceof Error ? err.message : String(err)} — continuing with cheerio links only`,
          );
        }
      }
    }

    opts.onPageFetched?.({
      url: normalized,
      ok: true,
      reason: raw.via === 'browser' ? 'via=browser' : undefined,
      totalFetched: pagesFetched,
    });

    collected.push({
      candidateId: normalized,
      uri: normalized,
      title: converted.title,
      markdown: converted.markdown,
      source: 'url',
      depth: next.depth,
      bytes: raw.bytes,
      via: raw.via,
      blocked_signals: raw.blockedSignals,
    });

    // BFS expansion (only if crawl enabled and we have depth budget).
    if (crawl.enabled && next.depth < maxDepth) {
      for (const link of converted.links) {
        const linkNormalized = normalizeUrl(link);
        if (!linkNormalized) continue;
        if (visited.has(linkNormalized)) continue;
        frontier.push({ url: linkNormalized, depth: next.depth + 1 });
      }
    }
  }

  return collected;
}

/** Strip fragments + trailing slashes that vary cosmetically. */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = '';
    // Drop default ports.
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    return u.toString();
  } catch {
    return null;
  }
}

function compilePattern(raw: string | null | undefined): RegExp | null {
  if (!raw) return null;
  try {
    return new RegExp(raw);
  } catch {
    return null;
  }
}

function matchesPattern(url: string, pattern: RegExp | null, defaultIfMissing: boolean): boolean {
  if (!pattern) return defaultIfMissing;
  return pattern.test(url);
}
