import { describe, expect, it } from 'vitest';
import { editorMediaKind, rawProjectFileUrl } from '../media-types.js';

describe('editor media types', () => {
  it('routes supported extensions to their specialized preview', () => {
    expect(editorMediaKind('site/index.HTML')).toBe('html');
    expect(editorMediaKind('assets/logo.SVG')).toBe('svg');
    expect(editorMediaKind('assets/photo.avif')).toBe('image');
    expect(editorMediaKind('clips/demo.webm')).toBe('video');
    expect(editorMediaKind('audio/theme.flac')).toBe('audio');
    expect(editorMediaKind('docs/manual.pdf')).toBe('pdf');
    expect(editorMediaKind('src/index.ts')).toBeNull();
  });

  it('encodes project-relative paths in the raw media URL', () => {
    expect(rawProjectFileUrl(42, 'assets/a b#c.png')).toBe(
      '/api/projects/42/file/raw?path=assets%2Fa%20b%23c.png',
    );
  });
});
