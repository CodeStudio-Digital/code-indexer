import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapTestI18n } from '../../../../i18n/test-bootstrap.js';
import type { RoundSnapshotFileSummary, SnapshotFileSummary } from '../../../snapshots/types.js';
import { FileChangeRow } from '../FileChangeRow.js';
import { SnapshotFilesProvider } from '../snapshot-files-context.js';

const BASELINE_ID = '00000000-0000-4000-8000-000000000007';
const ROUND_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000008';

function summary(addedLines: number, removedLines: number, filePath = 'src/example.ts'): SnapshotFileSummary {
  return {
    baselineId: BASELINE_ID,
    filePath,
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
  beforeAll(bootstrapTestI18n);

  it('never substitutes cumulative changes for an unavailable edit snapshot', () => {
    const file = summary(12, 3);
    const html = renderToStaticMarkup(createElement(
      SnapshotFilesProvider,
      { actions: null, files: new Map([[file.filePath, file]]) },
      createElement(FileChangeRow, { file: { path: file.filePath, op: 'edit' } }),
    ));

    expect(html).not.toContain('+12');
    expect(html).not.toContain('−3');
    expect(html).toContain('>–<');
  });

  it('uses the captured invocation even when the global baseline has newer edits', () => {
    const file = summary(12, 3, 'scripts/cluster-cli.mjs');
    const html = renderToStaticMarkup(createElement(
      SnapshotFilesProvider,
      { actions: null, files: new Map([[file.filePath, file]]) },
      createElement(FileChangeRow, {
        file: { path: 'D:\\proj\\scripts\\cluster-cli.mjs', op: 'edit' },
        toolSnapshot: { ...summary(2, 1, file.filePath), toolUseId: 'edit-one', fileIndex: 0, existedAfter: true },
      }),
    ));

    expect(html).toContain('+2');
    expect(html).toContain('−1');
    expect(html).not.toContain('+12');
    expect(html).not.toContain('>–<');
  });

  it('keeps the placeholder and explains itself for a file outside the project', () => {
    const file = summary(12, 3, 'src/example.ts');
    const html = renderToStaticMarkup(createElement(
      SnapshotFilesProvider,
      { actions: null, files: new Map([[file.filePath, file]]) },
      createElement(FileChangeRow, {
        file: { path: 'D:\\Claude\\scripts\\cluster-cli.mjs', op: 'edit' },
      }),
    ));

    expect(html).toContain('>–<');
    // Locale-agnostic: the row must carry *some* explanation, not a bare `–`.
    expect(html).toMatch(/title="[^"]+"/);
  });

  it('prefers the frozen round snapshot over the cumulative session baseline', () => {
    const global = summary(99, 40);
    const round: RoundSnapshotFileSummary = {
      ...summary(5, 2),
      roundMessageId: 100,
      roundSnapshotId: ROUND_SNAPSHOT_ID,
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
