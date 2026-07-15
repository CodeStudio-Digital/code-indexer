import { describe, expect, it } from 'vitest';
import type { OpenFile } from '../../../../state/workspace.js';
import { activeFileRenderEqual, tabBarFileEqual } from '../active-file-render.js';

const file = (overrides: Partial<OpenFile> = {}): OpenFile => ({
  projectId: 7,
  path: 'src/Service.php',
  content: '<?php',
  dirty: true,
  lastModified: 'one',
  ...overrides,
});

describe('activeFileRenderEqual', () => {
  it('ignores live Monaco content after the buffer is loaded', () => {
    expect(activeFileRenderEqual(file({ content: 'a' }), file({ content: 'a lot more text' }))).toBe(true);
  });

  it('renders load, dirty and external-change metadata transitions', () => {
    expect(activeFileRenderEqual(file({ content: null }), file({ content: 'loaded' }))).toBe(false);
    expect(activeFileRenderEqual(file({ dirty: false }), file({ dirty: true }))).toBe(false);
    expect(activeFileRenderEqual(file(), file({ externallyChanged: true }))).toBe(false);
  });

  it('does not suppress content rendering for markdown surfaces', () => {
    expect(activeFileRenderEqual(
      file({ path: 'README.md', content: 'before' }),
      file({ path: 'README.md', content: 'after' }),
    )).toBe(false);
  });

  it('keeps tab chrome stable while only the live buffer changes', () => {
    expect(tabBarFileEqual(file({ content: 'before' }), file({ content: 'after' }))).toBe(true);
    expect(tabBarFileEqual(file({ dirty: false }), file({ dirty: true }))).toBe(false);
  });
});
