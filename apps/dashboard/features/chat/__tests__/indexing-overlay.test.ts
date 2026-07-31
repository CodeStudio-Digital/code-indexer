import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useIndexStatusMock } = vi.hoisted(() => ({
  useIndexStatusMock: vi.fn(),
}));

vi.mock('../../workspace/jetbrains/status-bar/useIndexStatus.js', () => ({
  useIndexStatus: useIndexStatusMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: () => 'Indexing project in the background…',
  }),
}));

import { IndexingOverlay } from '../IndexingOverlay.js';

describe('IndexingOverlay', () => {
  beforeEach(() => {
    useIndexStatusMock.mockReset();
  });

  it('renders progress in normal flow without covering the composer', () => {
    useIndexStatusMock.mockReturnValue({
      phase: 'structural_indexing',
      progress: { current: 999, total: 0 },
    });

    const html = renderToStaticMarkup(
      createElement(IndexingOverlay, { projectId: 42 }),
    );

    expect(useIndexStatusMock).toHaveBeenCalledWith(42);
    expect(html).toContain('role="status"');
    expect(html).toContain('Indexing project in the background');
    expect(html).toContain('(999)');
    expect(html).not.toContain('absolute');
    expect(html).not.toContain('inset-0');
  });

  it('stays hidden when structural indexing is not active', () => {
    useIndexStatusMock.mockReturnValue({
      phase: 'structural_ready',
      progress: { current: 7_000, total: 7_000 },
    });

    expect(renderToStaticMarkup(
      createElement(IndexingOverlay, { projectId: 42 }),
    )).toBe('');
  });
});
