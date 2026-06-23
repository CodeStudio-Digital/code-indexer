import { describe, it, expect } from 'vitest';
import { extractDevUrl, isDevServerCommand, type DevOutputChunk } from '../dev-server-url.js';

function data(...lines: string[]): DevOutputChunk[] {
  return lines.map((l) => ({ type: 'data', data: l + '\n' }));
}

describe('extractDevUrl', () => {
  it('returns null when no URL appears', () => {
    expect(extractDevUrl(data('building...', 'compiled'))).toEqual({ url: null, authoritative: false });
  });

  it('treats a bare URL as provisional', () => {
    expect(extractDevUrl(data('VITE_API_URL=http://localhost:8282'))).toEqual({
      url: 'http://localhost:8282',
      authoritative: false,
    });
  });

  it('a ready-line URL is authoritative and wins over an earlier bare URL', () => {
    // The proxy/config echo (8282) must NOT win over the real listen line.
    const chunks = data(
      'env: VITE_API_URL=http://localhost:8282',
      '  ➜  Local:   http://localhost:5173/',
    );
    expect(extractDevUrl(chunks)).toEqual({ url: 'http://localhost:5173', authoritative: true });
  });

  it('matches common ready phrasings', () => {
    expect(extractDevUrl(data('Server listening on http://127.0.0.1:3000')).url).toBe('http://localhost:3000');
    expect(extractDevUrl(data('Ready on http://localhost:8787')).url).toBe('http://localhost:8787');
    expect(extractDevUrl(data('available at: http://0.0.0.0:4321')).authoritative).toBe(true);
  });

  it('ignores non-data chunks', () => {
    const chunks: DevOutputChunk[] = [
      { type: 'exit', data: undefined },
      { type: 'data', data: '➜ Local: http://localhost:5174/' },
    ];
    expect(extractDevUrl(chunks).url).toBe('http://localhost:5174');
  });
});

describe('isDevServerCommand', () => {
  it('matches dev/serve/preview/start/watch and tool names', () => {
    expect(isDevServerCommand('npm run dev')).toBe(true);
    expect(isDevServerCommand('yarn serve')).toBe(true);
    expect(isDevServerCommand('vite')).toBe(true);
    expect(isDevServerCommand('wrangler dev')).toBe(true);
    expect(isDevServerCommand('npm run cf:preview')).toBe(true);
  });

  it('matches via label when command is opaque', () => {
    expect(isDevServerCommand('node ./x.mjs', 'dev')).toBe(true);
  });

  it('does not match unrelated commands', () => {
    expect(isDevServerCommand('npm run build')).toBe(false);
    expect(isDevServerCommand('npm test')).toBe(false);
    expect(isDevServerCommand('git status')).toBe(false);
  });
});
