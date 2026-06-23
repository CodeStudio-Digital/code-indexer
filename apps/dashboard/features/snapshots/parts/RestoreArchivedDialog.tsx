/**
 * RestoreArchivedDialog — the reversal surface for the memory consolidator.
 * Lists snapshots the consolidator archived (GC'd) and lets the user restore
 * any of them. Restoring clears the embedding hash server-side so the backfill
 * re-embeds the row. Opened from the "archived N" chip on the Memory health card.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArchiveRestore, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { apiPost, useApi } from '../../../hooks/useApi.js';
import { cn, formatRelativeTime } from '../../../lib/utils.js';
import { CATEGORY_COLORS } from '../snapshot-types.js';

interface ArchivedRow {
  id: number;
  title: string;
  category: string;
  archived_reason: string | null;
  archived_at: string | null;
}

interface Props {
  projectId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful restore so the parent can refresh its totals. */
  onRestored?: () => void;
}

export function RestoreArchivedDialog({ projectId, open, onOpenChange, onRestored }: Props) {
  const { t } = useTranslation('projects');
  const { data } = useApi<{ archived: ArchivedRow[] }>(
    open ? `/projects/${projectId}/snapshots/archived?limit=200` : '',
  );
  const [restoring, setRestoring] = useState<number | null>(null);
  const [removed, setRemoved] = useState<Set<number>>(new Set());

  const rows = useMemo(
    () => (data?.archived ?? []).filter((r) => !removed.has(r.id)),
    [data, removed],
  );

  const restore = async (id: number) => {
    setRestoring(id);
    try {
      await apiPost(`/snapshots/${id}/unarchive`, {});
      setRemoved((prev) => new Set(prev).add(id));
      onRestored?.();
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('memory.restore.title')}</DialogTitle>
          <DialogDescription>{t('memory.restore.subtitle')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {rows.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {t('memory.restore.empty')}
            </div>
          ) : (
            <ul className="space-y-1">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded border bg-card/40 px-2 py-1.5">
                  <span
                    className={cn(
                      'px-1.5 py-0.5 rounded text-[9px] font-medium capitalize shrink-0',
                      CATEGORY_COLORS[r.category] ?? CATEGORY_COLORS.note,
                    )}
                  >
                    {r.category}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{r.title}</div>
                    <div className="truncate text-[10px] text-muted-foreground" title={r.archived_reason ?? ''}>
                      {r.archived_reason}
                      {r.archived_at && ` · ${formatRelativeTime(r.archived_at)}`}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-xs shrink-0"
                    disabled={restoring === r.id}
                    onClick={() => restore(r.id)}
                  >
                    {restoring === r.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <ArchiveRestore className="h-3.5 w-3.5" />}
                    {restoring === r.id ? t('memory.restore.restoring') : t('memory.restore.action')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
