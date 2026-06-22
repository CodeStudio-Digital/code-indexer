/**
 * Index portion of the StatusBar — the indexing chip + file/symbol counters.
 *
 * Owns the `useIndexStatus` subscription so the live index frames (~6×/s
 * during a scan) re-render ONLY this tiny section, not the whole footer with
 * its git Popover/Tooltip subtree. Counters prefer the live stream and fall
 * back to the project row's DENORMALIZED file_count/symbol_count (a single-row
 * read on `/projects/:id`, already fetched on open) — NOT the `/stats`
 * aggregate, whose full files/symbols-table scan froze the main thread (and
 * thus every screen) on project open.
 */
import { memo } from 'react';
import { useApi } from '../../../../hooks/useApi.js';
import { IndexStatusChip } from './IndexStatusChip.js';
import { useIndexStatus } from './useIndexStatus.js';

function IndexStatusSectionImpl({ projectId }: { projectId: number }) {
  const { data: project } = useApi<{ file_count: number | null; symbol_count: number | null }>(
    `/projects/${projectId}`,
  );
  const indexStatus = useIndexStatus(projectId);
  const fileCount = indexStatus?.fileCount ?? project?.file_count ?? undefined;
  const symbolCount = indexStatus?.symbolCount ?? project?.symbol_count ?? undefined;

  return (
    <>
      <IndexStatusChip status={indexStatus} />
      <span className="opacity-40">·</span>
      {fileCount !== undefined && symbolCount !== undefined ? (
        <>
          <span className="tabular-nums">{fileCount.toLocaleString()} files</span>
          <span className="opacity-40">·</span>
          <span className="tabular-nums">{symbolCount.toLocaleString()} symbols</span>
          <span className="opacity-40">·</span>
        </>
      ) : (
        // Reserve the counters' slot while the first stats/index frame loads so
        // they don't collapse→expand and shove the language/AI chips rightward
        // on initial open. Empty spacer = no new user-facing literal.
        <span className="inline-block w-36" aria-hidden />
      )}
    </>
  );
}

export const IndexStatusSection = memo(IndexStatusSectionImpl);
