import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMediaFileResponse,
  mediaContentType,
  parseByteRange,
  prepareProjectPreviewCss,
  prepareProjectPreviewHtml,
} from '../media-file-response.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('media file responses', () => {
  it('recognizes editor preview media types without sniffing', () => {
    expect(mediaContentType('logo.SVG')).toBe('image/svg+xml');
    expect(mediaContentType('movie.webm')).toBe('video/webm');
    expect(mediaContentType('manual.pdf')).toBe('application/pdf');
    expect(mediaContentType('index.html')).toBe('text/html; charset=utf-8');
    expect(mediaContentType('styles.css')).toBe('text/css; charset=utf-8');
    expect(mediaContentType('font.woff2')).toBe('font/woff2');
    expect(mediaContentType('unknown.bin')).toBe('application/octet-stream');
  });

  it('keeps navigated HTML links and assets inside the project preview', () => {
    const html = prepareProjectPreviewHtml(
      '<html><body><a href="/about.html">About</a><img src="logo.png"></body></html>',
      '/api/projects/3/preview/pages/',
      '/api/projects/3/preview/',
    );

    expect(html).toContain('<base href="/api/projects/3/preview/pages/">');
    expect(html).toContain('href="/api/projects/3/preview/about.html"');
    expect(html).toContain('src="logo.png"');
  });

  it('keeps root-relative CSS assets inside the project preview', () => {
    const css = prepareProjectPreviewCss(
      '@import "/theme/base.css"; .hero { background: url(/img/hero.png) }',
      '/api/projects/3/preview/',
    );
    expect(css).toContain('@import "/api/projects/3/preview/theme/base.css"');
    expect(css).toContain('url(/api/projects/3/preview/img/hero.png)');
  });

  it('parses open, bounded and suffix ranges', () => {
    expect(parseByteRange(undefined, 10)).toBeNull();
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=12-', 10)).toBe('invalid');
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBe('invalid');
  });

  it('streams a bounded range with media headers', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mcp-media-test-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'sample.mp4');
    await writeFile(filePath, Buffer.from('0123456789', 'utf8'));

    const response = await createMediaFileResponse(filePath, 'bytes=2-5');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('2345');
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mcp-media-test-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'sample.mp3');
    await writeFile(filePath, Buffer.from('abc', 'utf8'));

    const response = await createMediaFileResponse(filePath, 'bytes=9-');

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */3');
    expect(await response.text()).toBe('');
  });

  it('sandboxes HTML accidentally requested from the raw route', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mcp-media-test-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'unsafe.html');
    await writeFile(filePath, '<script>top.location = "/"</script>', 'utf8');

    const response = await createMediaFileResponse(filePath);

    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  });
});
