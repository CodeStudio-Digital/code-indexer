import { describe, it, expect } from 'vitest';
import { detectBlocked } from '../bot-detection.js';
import type { RenderResult } from '../render-backend.js';

function make(partial: Partial<RenderResult>): RenderResult {
  return {
    url: 'https://example.com',
    finalUrl: 'https://example.com',
    status: 200,
    html: '<html><head></head><body><main>plenty of normal content here ' +
      'spanning many words to safely clear the 500 byte floor for the body_too_short heuristic. ' +
      'More filler text. Even more filler text. And so on. ' +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
      'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
      'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut.' +
      '</main></body></html>',
    contentType: 'text/html',
    bytes: 700,
    via: 'plain',
    ...partial,
  };
}

describe('detectBlocked', () => {
  it('returns no signals on a normal page', () => {
    expect(detectBlocked(make({}))).toEqual([]);
  });

  it.each([403, 429, 451, 503])('flags HTTP %i as hard-block', (status) => {
    expect(detectBlocked(make({ status }))).toContain(`http_${status}`);
  });

  it('does NOT flag http_200 even when other signals fire', () => {
    const signals = detectBlocked(make({ status: 200, bytes: 100, html: '<html></html>' }));
    expect(signals).not.toContain('http_200');
  });

  it('flags body_too_short when 200 OK with <500 bytes', () => {
    expect(detectBlocked(make({ bytes: 200, html: '<html><body>tiny</body></html>' })))
      .toContain('body_too_short');
  });

  it('does NOT flag body_too_short on non-200 responses (the http_ signal already covers it)', () => {
    const signals = detectBlocked(make({ status: 403, bytes: 100, html: '<html></html>' }));
    expect(signals).not.toContain('body_too_short');
    expect(signals).toContain('http_403');
  });

  it('flags cloudflare_challenge on canonical Cloudflare strings', () => {
    const cf = '<html><head><title>Just a moment...</title></head><body>' +
      '<div class="cf-browser-verification">checking your browser</div></body></html>';
    expect(detectBlocked(make({ html: cf, bytes: cf.length }))).toContain('cloudflare_challenge');
  });

  it('flags spa_shell when text is tiny and scripts are plentiful', () => {
    const html = '<html><head>' +
      '<script src="a.js"></script>' +
      '<script src="b.js"></script>' +
      '<script src="c.js"></script>' +
      '</head><body><div id="root"></div></body></html>';
    expect(detectBlocked(make({ html, bytes: html.length }))).toContain('spa_shell');
  });

  it('does NOT flag spa_shell when text content is rich even with many scripts', () => {
    const longText = 'Documentation about something useful. '.repeat(50);
    const html = `<html><head>
      <script>1</script><script>2</script><script>3</script>
    </head><body><main>${longText}</main></body></html>`;
    expect(detectBlocked(make({ html, bytes: html.length }))).not.toContain('spa_shell');
  });

  it('flags js_required_notice on the canonical phrase', () => {
    const html = '<html><body>Please enable JavaScript to view this site.</body></html>';
    expect(detectBlocked(make({ html, bytes: html.length, status: 200 })))
      .toContain('js_required_notice');
  });

  it('can return multiple signals together', () => {
    const html = '<html><body>Just a moment... please enable javascript</body></html>';
    const signals = detectBlocked(make({ status: 503, html, bytes: html.length }));
    expect(signals).toEqual(expect.arrayContaining(['http_503', 'cloudflare_challenge', 'js_required_notice']));
  });
});
