/**
 * Non-blocking composer indexing status — a tiny isolated leaf.
 *
 * It owns the FULL `useIndexStatus` subscription (re-renders ~6×/s during a
 * pass) so the heavy AgentChat tree doesn't have to. This leaf is the only
 * thing that re-renders on every progress frame, and it stays in normal layout
 * flow so indexing can never cover or disable the composer.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useIndexStatus } from '../workspace/jetbrains/status-bar/useIndexStatus.js';

function compact(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

function IndexingOverlayImpl({ projectId }: { projectId: number }) {
  const { t } = useTranslation('chat');
  const status = useIndexStatus(projectId);
  const busy = status?.phase === 'scanning' || status?.phase === 'structural_indexing';
  if (!busy) return null;

  const p = status?.progress;
  const detail = p && p.current > 0
    ? p.total > 0
      ? ` (${compact(p.current)}/${compact(p.total)})`
      : ` (${compact(p.current)})`
    : '';

  return (
    <div
      role="status"
      aria-busy="true"
      className="flex min-h-7 items-center justify-end gap-2 bg-card/45 px-3 py-1 text-xs text-muted-foreground"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span className="tabular-nums">
        {t('global.indexing')}
        {detail}
      </span>
    </div>
  );
}

export const IndexingOverlay = memo(IndexingOverlayImpl);
