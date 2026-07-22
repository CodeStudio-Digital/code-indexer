import { describe, expect, it } from 'vitest';
import {
  buildHtmlPreviewDocument,
  projectPreviewDirectoryUrl,
  projectPreviewRootUrl,
} from '../html-preview.js';

describe('HTML preview document', () => {
  it('resolves relative assets beside the file and rewrites root-relative assets', () => {
    const root = projectPreviewRootUrl(42);
    const directory = projectPreviewDirectoryUrl(42, 'site/pages/home page.html');
    const html = buildHtmlPreviewDocument(
      '<html><head><link href="/styles.css"><script src="app.js"></script></head><body><a href="about.html">About</a><img src="/img/logo.png"></body></html>',
      directory,
      root,
    );

    expect(directory).toBe('/api/projects/42/preview/site/pages/');
    expect(html).toContain('<base href="/api/projects/42/preview/site/pages/">');
    expect(html).toContain('href="/api/projects/42/preview/styles.css"');
    expect(html).toContain('src="/api/projects/42/preview/img/logo.png"');
    expect(html).toContain('href="about.html"');
    expect(html).toContain("connect-src 'none'; object-src 'none'");
  });

  it('injects a head into HTML fragments', () => {
    const html = buildHtmlPreviewDocument('<main>Hello</main>', '/preview/pages/', '/preview/');
    expect(html).toMatch(/^<head><base href="\/preview\/pages\/">/);
    expect(html).toContain('<main>Hello</main>');
  });
});
