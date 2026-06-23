/**
 * Pins the behavior added on 2026-05-20 for the Unity ScriptReference
 * crawl regression: link extraction must read the FULL document
 * (including <nav>, <aside>, sidebars) BEFORE stripping. Otherwise BFS
 * frontier dies after the seed on doc sites that put the page-to-page
 * navigation tree outside of <main>.
 */
import { describe, it, expect } from 'vitest';
import { convertHtmlToMarkdown } from '../html-to-markdown.js';

describe('convertHtmlToMarkdown — link extraction scope', () => {
  it('picks up links from <aside> / <nav> sidebars even though they get stripped from markdown', () => {
    // Mimics Unity ScriptReference layout: <main> has only welcome text,
    // sidebar (<aside class="sidebar">) holds the API navigation tree.
    const html = `
      <html>
        <body>
          <header><a href="/home.html">Home</a></header>
          <aside class="sidebar">
            <a href="/api/Camera.html">Camera</a>
            <a href="/api/GameObject.html">GameObject</a>
            <a href="/api/Rigidbody.html">Rigidbody</a>
          </aside>
          <main>
            <h1>Welcome to ScriptReference</h1>
            <p>Browse the API tree on the left.</p>
          </main>
          <footer><a href="https://other.example/legal">Legal</a></footer>
        </body>
      </html>
    `;
    const result = convertHtmlToMarkdown(html, { baseUrl: 'https://docs.example.com/index.html' });
    // Markdown should NOT contain the sidebar / footer text (still
    // stripped). Title comes from <h1> since there's no <title>.
    expect(result.title).toBe('Welcome to ScriptReference');
    expect(result.markdown).toContain('Welcome');
    expect(result.markdown).toContain('Browse the API tree');
    expect(result.markdown).not.toContain('Camera');
    expect(result.markdown).not.toContain('Legal');

    // Links should include EVERY same-origin <a href> from the full doc,
    // regardless of where it lived (sidebar, header, main, footer).
    const urls = result.links;
    expect(urls).toContain('https://docs.example.com/home.html');
    expect(urls).toContain('https://docs.example.com/api/Camera.html');
    expect(urls).toContain('https://docs.example.com/api/GameObject.html');
    expect(urls).toContain('https://docs.example.com/api/Rigidbody.html');
    // The footer link goes to other.example — sameOriginOnly (default true) drops it.
    expect(urls.find((u) => u.includes('other.example'))).toBeUndefined();
  });

  it('honors sameOriginOnly: false (keeps cross-origin sidebar links)', () => {
    const html = `
      <body>
        <nav><a href="https://other.example/page">Other</a></nav>
        <main><p>body text long enough to matter</p></main>
      </body>
    `;
    const result = convertHtmlToMarkdown(html, {
      baseUrl: 'https://docs.example.com/x.html',
      sameOriginOnly: false,
    });
    expect(result.links).toContain('https://other.example/page');
  });

  it('dedupes links that appear in multiple regions (nav + content)', () => {
    const html = `
      <body>
        <nav><a href="/x.html">X</a></nav>
        <main>
          <a href="/x.html">X again</a>
          <p>body</p>
        </main>
      </body>
    `;
    const result = convertHtmlToMarkdown(html, { baseUrl: 'https://docs.example.com/seed.html' });
    const xLinks = result.links.filter((l) => l.endsWith('/x.html'));
    expect(xLinks.length).toBe(1);
  });

  it('still detects noindex regardless of link extraction changes', () => {
    const html = '<html><head><meta name="robots" content="noindex"></head><body><a href="/x.html">x</a></body></html>';
    const result = convertHtmlToMarkdown(html, { baseUrl: 'https://example.com/' });
    expect(result.noindex).toBe(true);
  });

  it('emits a deep-link anchor on each heading ({#id} preferred, slug fallback)', () => {
    const html = `
      <body>
        <main>
          <h2 id="add-force">Rigidbody.AddForce</h2>
          <p>Adds a force to the rigidbody so the object starts moving.</p>
          <h2>Manual Setup Guide</h2>
          <p>An explanation long enough that the section is kept by the gate.</p>
        </main>
      </body>
    `;
    const result = convertHtmlToMarkdown(html, { baseUrl: 'https://docs.example.com/x.html' });
    // Real HTML id wins.
    expect(result.markdown).toContain('## Rigidbody.AddForce {#add-force}');
    // No id → GitHub-style slug fallback.
    expect(result.markdown).toContain('## Manual Setup Guide {#manual-setup-guide}');
  });
});
