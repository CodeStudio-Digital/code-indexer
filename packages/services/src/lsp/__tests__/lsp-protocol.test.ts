/**
 * Pure tests for the LSP plumbing's two classic bug farms: Content-Length
 * framing (BYTES, not chars) and Windows URI round-trips.
 */
import { describe, it, expect } from 'vitest';
import { encodeMessage, FrameParser } from '../jsonrpc-framing.js';
import { pathToUri, uriToPath, toLsp, fromLsp, hoverToMarkdown } from '../lsp-protocol.js';

describe('jsonrpc framing', () => {
  it('Content-Length counts UTF-8 BYTES (accents/emoji)', () => {
    const msg = { jsonrpc: '2.0', method: 'x', params: { text: 'ação 🚀' } };
    const buf = encodeMessage(msg);
    const header = buf.toString('utf-8').split('\r\n\r\n')[0];
    const declared = Number(/Content-Length: (\d+)/.exec(header)![1]);
    const body = JSON.stringify(msg);
    expect(declared).toBe(Buffer.byteLength(body, 'utf-8'));
    expect(declared).toBeGreaterThan(body.length); // chars < bytes here
  });

  it('parser reassembles split chunks and multiple messages per chunk', () => {
    const parser = new FrameParser();
    const a = encodeMessage({ id: 1 });
    const b = encodeMessage({ id: 2, result: 'ok' });
    const all = Buffer.concat([a, b]);
    // Feed in awkward fragments: header split mid-token + bodies merged.
    const out: unknown[] = [];
    out.push(...parser.push(all.subarray(0, 9)));
    out.push(...parser.push(all.subarray(9, a.length + 5)));
    out.push(...parser.push(all.subarray(a.length + 5)));
    expect(out).toEqual([{ id: 1 }, { id: 2, result: 'ok' }]);
  });

  it('skips a malformed body without killing the stream', () => {
    const errors: string[] = [];
    const parser = new FrameParser((e) => errors.push(e.message));
    const bad = Buffer.from('Content-Length: 5\r\n\r\n{oops', 'utf-8');
    const good = encodeMessage({ id: 3 });
    const out = parser.push(Buffer.concat([bad, good]));
    expect(out).toEqual([{ id: 3 }]);
    expect(errors.length).toBe(1);
  });
});

describe('lsp-protocol conversions', () => {
  it('windows uri round-trip (both encodings of the drive colon)', () => {
    expect(pathToUri('D:\\poa-monorepo\\backend\\app.php')).toBe('file:///d:/poa-monorepo/backend/app.php');
    expect(uriToPath('file:///d:/poa/app.php')).toBe('d:/poa/app.php');
    expect(uriToPath('file:///d%3A/poa/app.php')).toBe('d:/poa/app.php');
    expect(uriToPath(pathToUri('C:/Users/maico/projeto açaí/x.py'))).toBe('c:/Users/maico/projeto açaí/x.py');
  });

  it('positions are ±1 only', () => {
    expect(toLsp({ line: 1, column: 1 })).toEqual({ line: 0, character: 0 });
    expect(fromLsp({ line: 9, character: 4 })).toEqual({ line: 10, column: 5 });
  });

  it('hover content shapes normalize to markdown', () => {
    expect(hoverToMarkdown({ contents: 'plain' })).toBe('plain');
    expect(hoverToMarkdown({ contents: { kind: 'markdown', value: '**md**' } })).toBe('**md**');
    expect(hoverToMarkdown({ contents: [{ language: 'php', value: 'function f()' }, 'doc'] }))
      .toBe('```php\nfunction f()\n```\n\ndoc');
    expect(hoverToMarkdown({ contents: '' })).toBeNull();
  });
});
