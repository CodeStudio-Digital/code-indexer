/**
 * Composer indexing overlay — a tiny isolated leaf.
 *
 * It owns the FULL `useIndexStatus` subscription (re-renders ~6×/s during a
 * pass) so the heavy AgentChat tree doesn't have to: AgentChat gates on the
 * boolean `useIndexBusy` (flips twice per pass) while THIS ~20px overlay is the
 * only thing that re-renders on every progress frame.
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
      className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-card/85 backdrop-blur-sm text-sm text-muted-foreground"
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="tabular-nums">
        {t('global.indexing')}
        {detail}
      </span>
    </div>
  );
}

export const IndexingOverlay = memo(IndexingOverlayImpl);
