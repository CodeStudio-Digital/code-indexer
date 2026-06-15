/**
 * Index portion of the StatusBar — the indexing chip + file/symbol counters.
 *
 * Owns the `useIndexStatus` subscription so the live index frames (~6×/s
 * during a scan) re-render ONLY this tiny section, not the whole footer with
 * its git Popover/Tooltip subtree. Counters prefer the live stream and fall
 * back to the one-shot `/stats` fetch (which freezes at page-load values).
 */
import { memo } from 'react';
import { useApi } from '../../../../hooks/useApi.js';
import { IndexStatusChip } from './IndexStatusChip.js';
import { useIndexStatus } from './useIndexStatus.js';

function IndexStatusSectionImpl({ projectId }: { projectId: number }) {
  const { data: stats } = useApi<{ file_count: number; symbol_count: number; total_lines: number }>(
    `/projects/${projectId}/stats`,
  );
  const indexStatus = useIndexStatus(projectId);
  const fileCount = indexStatus?.fileCount ?? stats?.file_count;
  const symbolCount = indexStatus?.symbolCount ?? stats?.symbol_count;

  return (
    <>
      <IndexStatusChip status={indexStatus} />
      <span className="opacity-40">·</span>
      {fileCount !== undefined && symbolCount !== undefined && (
        <>
          <span>{fileCount.toLocaleString()} files</span>
          <span className="opacity-40">·</span>
          <span>{symbolCount.toLocaleString()} symbols</span>
          <span className="opacity-40">·</span>
        </>
      )}
    </>
  );
}

export const IndexStatusSection = memo(IndexStatusSectionImpl);
