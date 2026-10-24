import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webFetch, webSearch } from '@mcp/code-agent/tools/web.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { newSessionId } from '@mcp/session-storage';
import type { PublicWebRequest } from '@mcp/shared/utils/public-web-request.js';

vi.mock('@mcp/shared/utils/public-web-request.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/shared/utils/public-web-request.js')>();
  return {
    ...actual,
    readPublicWeb: async (input: PublicWebRequest) => {
      const url = actual.validatePublicWebUrl(input.url).href;
      const response = await globalThis.fetch(url, { headers: input.headers, signal: input.signal });
      const text = typeof response.text === 'function'
        ? await response.text() : JSON.stringify(await response.json());
      return {
        url, status: response.status, statusText: response.statusText ?? '',
        contentType: response.headers?.get('content-type') ?? 'application/json',
        text, truncated: false, inputBytes: Buffer.byteLength(text), inputSizeExact: true,
      };
    },
  };
});

// ── Helpers ─────────────────────────────────────────────────────────

const ctx = (): ToolContext => ({ cwd: '/fake', projectName: 'test', sessionId: newSessionId() });

// Bridge the bounded acquisition port to per-test fixtures. URL validation and
// content conversion stay real; no DNS lookup or network socket is opened.

function makeHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

// ── web_fetch ────────────────────────────────────────────────────────

describe('web_fetch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches a URL and returns markdown-converted content', async () => {
    const html = makeHtml('Hello', '<h1>Title</h1><p>Paragraph</p>');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: () => Promise.resolve(html),
    });

    const result = await webFetch.handler({ url: 'https://example.com' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Title');
    expect(result.content).toContain('Paragraph');
  });

  it('rejects non-HTTP/HTTPS URLs (SSRF guard)', async () => {
    const result = await webFetch.handler({ url: 'ftp://evil.com/file' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('http:// and https://');
  });

  it('rejects private/loopback IPs', async () => {
    const result = await webFetch.handler({ url: 'http://127.0.0.1/admin' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('private');
  });

  it('rejects URLs without protocol', async () => {
    const result = await webFetch.handler({ url: 'example.com' }, ctx());
    expect(result.isError).toBe(true);
  });

  it('rejects empty URL', async () => {
    const result = await webFetch.handler({ url: '' }, ctx());
    expect(result.isError).toBe(true);
  });

  it('handles fetch failure gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const result = await webFetch.handler({ url: 'https://down.example.com' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('web_fetch failed');
  });

  it('handles non-OK HTTP status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      text: () => Promise.resolve(''),
    });
    const result = await webFetch.handler({ url: 'https://example.com/missing' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('404');
  });

  it('passes JSON through as-is when content-type is application/json', async () => {
    const json = '{"key": "value"}';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(json),
    });

    const result = await webFetch.handler({ url: 'https://api.example.com/data' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"key"');
  });
});

// ── web_search ───────────────────────────────────────────────────────

describe('web_search', () => {
  const originalFetch = globalThis.fetch;
  const originalBraveKey = process.env.BRAVE_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.BRAVE_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBraveKey !== undefined) {
      process.env.BRAVE_API_KEY = originalBraveKey;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
  });

  it('rejects empty query', async () => {
    const result = await webSearch.handler({ query: '' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('query must contain between 1 and 4096');
  });

  it('falls back to DuckDuckGo when BRAVE_API_KEY is not set', async () => {
    // DDG returns HTML with result__a links
    const ddgHtml = `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="https://example.com/page1">Example Page 1</a>
          </h2>
          <a class="result__snippet" href="#">This is a snippet about example page 1.</a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="https://example.com/page2">Example Page 2</a>
          </h2>
          <a class="result__snippet" href="#">Another snippet for page 2.</a>
        </div>
      </div>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(ddgHtml),
    });

    const result = await webSearch.handler({ query: 'test search' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Example Page 1');
    expect(result.content).toContain('Example Page 2');
    expect(result.content).toContain('duckduckgo');
  });

  it('uses Brave when BRAVE_API_KEY is set', async () => {
    process.env.BRAVE_API_KEY = 'test-key-123';
    const braveResponse = {
      web: {
        results: [
          { title: 'Brave Result', url: 'https://brave.example.com', description: 'A brave result snippet' },
        ],
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(braveResponse),
    });

    const result = await webSearch.handler({ query: 'brave test' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Brave Result');
    expect(result.content).toContain('brave');
  });

  it('falls back from Brave failure to DDG', async () => {
    process.env.BRAVE_API_KEY = 'bad-key';
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url: any, _opts?: any) => {
      callCount++;
      if (callCount === 1) {
        // Brave call — searchBrave checks res.ok and throws on !ok.
        // It also calls res.json(), so we provide that.
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () => Promise.resolve({ web: { results: [] } }),
        });
      }
      // DDG fallback succeeds — searchDuckDuckGo calls res.text()
      const ddgHtml = `
        <div class="result results_links results_links_deep web-result">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a rel="nofollow" class="result__a" href="https://fallback.example.com">Fallback Result</a>
            </h2>
            <a class="result__snippet" href="#">Fallback snippet</a>
          </div>
        </div>
      `;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(ddgHtml),
      });
    });

    const result = await webSearch.handler({ query: 'fallback test' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Fallback Result');
    expect(result.content).toContain('brave failed');
  });

  it('filters by allowed_domains', async () => {
    const ddgHtml = `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="https://docs.python.org/page">Python Docs</a>
          </h2>
          <a class="result__snippet" href="#">Python snippet</a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="https://w3schools.com/page">W3Schools</a>
          </h2>
          <a class="result__snippet" href="#">W3 snippet</a>
        </div>
      </div>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(ddgHtml),
    });

    const result = await webSearch.handler(
      { query: 'python', allowed_domains: ['docs.python.org'] },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Python Docs');
    expect(result.content).not.toContain('W3Schools');
  });

  it('filters by blocked_domains', async () => {
    const ddgHtml = `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="https://docs.python.org/page">Python Docs</a>
          </h2>
          <a class="result__snippet" href="#">Python snippet</a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="https://w3schools.com/page">W3Schools</a>
          </h2>
          <a class="result__snippet" href="#">W3 snippet</a>
        </div>
      </div>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(ddgHtml),
    });

    const result = await webSearch.handler(
      { query: 'python', blocked_domains: ['w3schools.com'] },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Python Docs');
    expect(result.content).not.toContain('W3Schools');
  });

  it('returns "No results" when DDG finds nothing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<html><body>No results found</body></html>'),
    });

    const result = await webSearch.handler({ query: 'xyznonexistent123' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('No results');
  });

  it('handles complete search failure (both backends down)', async () => {
    process.env.BRAVE_API_KEY = 'bad-key';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve(''),
    });

    const result = await webSearch.handler({ query: 'fail' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('web_search failed');
  });
});
