/**
 * Pins the `required_path` substring filter on the URL crawler.
 *
 * The feature exists so users can index, say, Unity Manual 6000.3 without
 * the BFS frontier wandering into 6000.2 / 2022.3 / etc. — set
 * `required_path: '/6000.3/Documentation/Manual/'` and any link missing
 * that substring is silently dropped.
 */
import { describe, it, expect } from 'vitest';
import { crawlUrl } from '../crawler.js';
import type { RawPage } from '../types.js';
import type { RenderBackend, RenderResult } from '../render-backend.js';

interface FakePage { url: string; html: string }

/**
 * In-memory render backend whose `render(url)` returns whatever HTML was
 * registered for that URL. Unknown URLs fail with 404 so the crawler's
 * normal "skip non-html/non-200" path exercises.
 */
function fakeRenderer(pages: FakePage[]): RenderBackend {
  const byUrl = new Map<string, string>(pages.map((p) => [p.url, p.html]));
  return {
    name: 'plain',
    async isAvailable() { return true; },
    async render(url): Promise<RenderResult> {
      const html = byUrl.get(url);
      if (html == null) {
        return { url, finalUrl: url, status: 404, html: '', contentType: 'text/html', bytes: 0, via: 'plain' };
      }
      return { url, finalUrl: url, status: 200, html, contentType: 'text/html', bytes: html.length, via: 'plain' };
    },
  };
}

function htmlWith(title: string, links: string[]): string {
  const linksHtml = links.map((href) => `<a href="${href}">${href}</a>`).join('\n');
  // Body must be >500 chars so the relevance gate's heuristic doesn't flag
  // it as too-short. Pad with neutral text.
  const padding = 'Content block. '.repeat(50);
  return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${padding}${linksHtml}</main></body></html>`;
}

function collectedUris(pages: RawPage[]): string[] {
  return pages.map((p) => p.uri).sort();
}

describe('crawlUrl required_path filter', () => {
  it('drops crawled links whose URL does not contain the substring', async () => {
    const renderer = fakeRenderer([
      {
        url: 'https://docs.example.com/6000.3/Manual/UnityManual.html',
        html: htmlWith('Manual 6000.3', [
          '/6000.3/Manual/Physics.html',           // match → indexed
          '/6000.2/Manual/Physics.html',           // miss → skipped
          '/6000.3/ScriptReference/Rigidbody.html',// miss (not /Manual/) → skipped
        ]),
      },
      {
        url: 'https://docs.example.com/6000.3/Manual/Physics.html',
        html: htmlWith('Physics', []),
      },
      // These exist on the fake server but should never be requested.
      { url: 'https://docs.example.com/6000.2/Manual/Physics.html', html: htmlWith('Old', []) },
      { url: 'https://docs.example.com/6000.3/ScriptReference/Rigidbody.html', html: htmlWith('Ref', []) },
    ]);

    const pages = await crawlUrl({
      seedUrl: 'https://docs.example.com/6000.3/Manual/UnityManual.html',
      sourceId: 1,
      crawl: {
        enabled: true,
        max_pages: 10,
        max_depth: 2,
        same_origin: true,
        required_path: '/6000.3/Manual/',
      },
      renderer,
    });

    expect(collectedUris(pages)).toEqual([
      'https://docs.example.com/6000.3/Manual/Physics.html',
      'https://docs.example.com/6000.3/Manual/UnityManual.html',
    ]);
  });

  it('throws when the seed itself does not satisfy required_path', async () => {
    const renderer = fakeRenderer([]);
    await expect(
      crawlUrl({
        seedUrl: 'https://docs.example.com/6000.2/Manual/Index.html',
        sourceId: 1,
        crawl: {
          enabled: true,
          max_pages: 10,
          max_depth: 1,
          same_origin: true,
          required_path: '/6000.3/Manual/',
        },
        renderer,
      }),
    ).rejects.toThrow(/does not contain the required substring/);
  });

  it('treats empty/whitespace required_path as "no filter" (no false rejection)', async () => {
    const renderer = fakeRenderer([
      {
        url: 'https://docs.example.com/anywhere/page.html',
        html: htmlWith('Page', []),
      },
    ]);
    const pages = await crawlUrl({
      seedUrl: 'https://docs.example.com/anywhere/page.html',
      sourceId: 1,
      crawl: {
        enabled: false,
        max_pages: 1,
        max_depth: 0,
        same_origin: true,
        required_path: '   ', // whitespace only → off
      },
      renderer,
    });
    expect(pages.length).toBe(1);
  });

  it('null required_path leaves all URLs eligible', async () => {
    const renderer = fakeRenderer([
      {
        url: 'https://docs.example.com/seed.html',
        html: htmlWith('Seed', ['/anything.html']),
      },
      { url: 'https://docs.example.com/anything.html', html: htmlWith('Any', []) },
    ]);
    const pages = await crawlUrl({
      seedUrl: 'https://docs.example.com/seed.html',
      sourceId: 1,
      crawl: { enabled: true, max_pages: 5, max_depth: 2, same_origin: true, required_path: null },
      renderer,
    });
    expect(collectedUris(pages)).toEqual([
      'https://docs.example.com/anything.html',
      'https://docs.example.com/seed.html',
    ]);
  });
});
