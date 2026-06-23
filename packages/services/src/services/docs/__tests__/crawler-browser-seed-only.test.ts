/**
 * Pins the `browser_seed_only` hybrid render mode on the crawler.
 *
 * Mode contract:
 *   - When `browser_seed_only` is true AND `force_browser` is false:
 *       the SEED page (depth=0) is fetched with `{ forceBrowser: true }`,
 *       every discovered LEAF (depth>=1) is fetched without it.
 *   - When `force_browser` is true: ALL pages get `{ forceBrowser: true }`
 *     and `browser_seed_only` is ignored (force_browser wins).
 *   - When neither flag is set: nothing changes — every fetch goes
 *     through the default `{ forceBrowser: undefined }` path.
 *
 * The renderer fake records every `render()` call so we can assert the
 * exact opts passed per URL.
 */
import { describe, it, expect } from 'vitest';
import { crawlUrl } from '../crawler.js';
import type { RenderBackend, RenderResult, RenderOpts } from '../render-backend.js';

interface RenderCall {
  url: string;
  forceBrowser: boolean;
}

interface FakePage {
  url: string;
  html: string;
}

function recordingRenderer(pages: FakePage[]): {
  renderer: RenderBackend;
  calls: RenderCall[];
} {
  const byUrl = new Map<string, string>(pages.map((p) => [p.url, p.html]));
  const calls: RenderCall[] = [];
  const renderer: RenderBackend = {
    name: 'plain',
    async isAvailable() { return true; },
    async render(url: string, opts?: RenderOpts): Promise<RenderResult> {
      calls.push({ url, forceBrowser: opts?.forceBrowser === true });
      const html = byUrl.get(url);
      if (html == null) {
        return { url, finalUrl: url, status: 404, html: '', contentType: 'text/html', bytes: 0, via: 'plain' };
      }
      return {
        url,
        finalUrl: url,
        status: 200,
        html,
        contentType: 'text/html',
        bytes: html.length,
        // Honor the requested mode in the result.via for completeness —
        // a real BrowserBackend would set 'browser'.
        via: opts?.forceBrowser ? 'browser' : 'plain',
      };
    },
  };
  return { renderer, calls };
}

function htmlWith(title: string, links: string[]): string {
  const linksHtml = links.map((href) => `<a href="${href}">${href}</a>`).join('\n');
  const padding = 'Content block. '.repeat(50);
  return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${padding}${linksHtml}</main></body></html>`;
}

// Helper: build a 3-page Unity-ish fixture (seed + 2 leaves linked from seed).
function unityLikeFixture() {
  return [
    {
      url: 'https://docs.example.com/api/index.html',
      html: htmlWith('API root', [
        '/api/Camera.html',
        '/api/Rigidbody.html',
      ]),
    },
    { url: 'https://docs.example.com/api/Camera.html', html: htmlWith('Camera', []) },
    { url: 'https://docs.example.com/api/Rigidbody.html', html: htmlWith('Rigidbody', []) },
  ];
}

describe('crawlUrl browser_seed_only', () => {
  it('passes forceBrowser=true ONLY on the depth-0 seed', async () => {
    const { renderer, calls } = recordingRenderer(unityLikeFixture());
    await crawlUrl({
      seedUrl: 'https://docs.example.com/api/index.html',
      sourceId: 1,
      crawl: {
        enabled: true,
        max_pages: 10,
        max_depth: 2,
        same_origin: true,
        browser_seed_only: true,
      },
      renderer,
    });
    const seed = calls.find((c) => c.url === 'https://docs.example.com/api/index.html');
    const camera = calls.find((c) => c.url === 'https://docs.example.com/api/Camera.html');
    const rigidbody = calls.find((c) => c.url === 'https://docs.example.com/api/Rigidbody.html');
    expect(seed).toBeDefined();
    expect(seed!.forceBrowser).toBe(true);
    expect(camera).toBeDefined();
    expect(camera!.forceBrowser).toBe(false);
    expect(rigidbody).toBeDefined();
    expect(rigidbody!.forceBrowser).toBe(false);
  });

  it('force_browser=true wins — every call gets forceBrowser:true regardless', async () => {
    const { renderer, calls } = recordingRenderer(unityLikeFixture());
    await crawlUrl({
      seedUrl: 'https://docs.example.com/api/index.html',
      sourceId: 1,
      crawl: {
        enabled: true,
        max_pages: 10,
        max_depth: 2,
        same_origin: true,
        // Both on — `force_browser` must dominate per documented priority.
        force_browser: true,
        browser_seed_only: true,
      },
      renderer,
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.forceBrowser).toBe(true);
    }
  });

  it('neither flag → every call uses the default (forceBrowser=false)', async () => {
    const { renderer, calls } = recordingRenderer(unityLikeFixture());
    await crawlUrl({
      seedUrl: 'https://docs.example.com/api/index.html',
      sourceId: 1,
      crawl: {
        enabled: true,
        max_pages: 10,
        max_depth: 2,
        same_origin: true,
      },
      renderer,
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.forceBrowser).toBe(false);
    }
  });

  it('single-page index (crawl_enabled=false, max_pages=1) still uses browser on the seed', async () => {
    // Edge case: seed-only mode is most useful when the user crawls a
    // tree, but the SINGLE-page indexer must also honor the flag — it
    // would be useless if the only call we make is plain.
    const { renderer, calls } = recordingRenderer([
      {
        url: 'https://docs.example.com/api/index.html',
        html: htmlWith('API root', []),
      },
    ]);
    await crawlUrl({
      seedUrl: 'https://docs.example.com/api/index.html',
      sourceId: 1,
      crawl: {
        enabled: false,
        max_pages: 1,
        max_depth: 0,
        browser_seed_only: true,
      },
      renderer,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.forceBrowser).toBe(true);
  });
});
