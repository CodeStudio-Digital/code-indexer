import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RoundSnapshotFileSummary, SnapshotFileSummary } from '../../../snapshots/types.js';
import { FileChangeRow } from '../FileChangeRow.js';
import { SnapshotFilesProvider } from '../snapshot-files-context.js';

function summary(addedLines: number, removedLines: number): SnapshotFileSummary {
  return {
    baselineId: 7,
    filePath: 'src/example.ts',
    status: 'active',
    existedBefore: true,
    oversized: false,
    firstSeenAt: '2026-07-14T00:00:00.000Z',
    lastEditedAt: '2026-07-14T00:00:01.000Z',
    closedAt: null,
    hunkCount: 1,
    pendingHunks: 1,
    addedLines,
    removedLines,
    resolved: false,
  };
}

describe('FileChangeRow', () => {
  it('shows the live session snapshot when the tool card has no round snapshot', () => {
    const file = summary(12, 3);
    const html = renderToStaticMarkup(createElement(
      SnapshotFilesProvider,
      { actions: null, files: new Map([[file.filePath, file]]) },
      createElement(FileChangeRow, { file: { path: file.filePath, op: 'edit' } }),
    ));

    expect(html).toContain('+12');
    expect(html).toContain('−3');
    expect(html).not.toContain('>–<');
  });

  it('prefers the frozen round snapshot over the cumulative session baseline', () => {
    const global = summary(99, 40);
    const round: RoundSnapshotFileSummary = {
      ...summary(5, 2),
      roundMessageId: 100,
      roundSnapshotId: 8,
      globalBaselineId: global.baselineId,
      projectId: 1,
    };
    const html = renderToStaticMarkup(createElement(
      SnapshotFilesProvider,
      { actions: null, files: new Map([[global.filePath, global]]) },
      createElement(FileChangeRow, {
        file: { path: global.filePath, op: 'edit' },
        snapshot: round,
        roundMessageId: 100,
      }),
    ));

    expect(html).toContain('+5');
    expect(html).toContain('−2');
    expect(html).not.toContain('+99');
  });
});
