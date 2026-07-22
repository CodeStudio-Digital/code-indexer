import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpenFile } from '../../../../state/workspace.js';
import { MediaView } from '../MediaView.js';
import type { BinaryMediaKind } from '../media-types.js';

function file(path: string): OpenFile {
  return {
    projectId: 9,
    path,
    content: null,
    dirty: false,
    lastModified: null,
  };
}

function render(kind: BinaryMediaKind, path: string): string {
  return renderToStaticMarkup(createElement(MediaView, { file: file(path), kind }));
}

describe('MediaView', () => {
  it('uses native preview elements backed by the raw project route', () => {
    const image = render('image', 'assets/cover image.png');
    const video = render('video', 'clips/demo.mp4');
    const audio = render('audio', 'audio/theme.ogg');
    const pdf = render('pdf', 'docs/manual.pdf');

    expect(image).toContain('<img');
    expect(image).toContain('/file/raw?path=assets%2Fcover%20image.png');
    expect(video).toContain('<video');
    expect(video).toContain('preload="metadata"');
    expect(audio).toContain('<audio');
    expect(pdf).toContain('<iframe');
  });
});
