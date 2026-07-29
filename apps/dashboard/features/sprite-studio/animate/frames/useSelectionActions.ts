/**
 * Shared multi-selection actions for the Frames browser (LEFT) and the
 * FrameInspector (RIGHT): bulk-delete (with the in-use-frames guard) and
 * add-to-timeline (via the AnimatePanel bridge). One implementation so both
 * rails behave identically.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm, toast } from '../../../../components/ui/prompt-dialog.js';
import { useAnimateSession } from '../animate-session-store.js';
import { bulkDeleteVersions } from '../api-anim-bulk.js';

export function useSelectionActions(projectId: number, refresh: () => void): {
  busy: boolean;
  deleteVersions: (ids: string[]) => Promise<void>;
  addToTimeline: (orderedIds: string[]) => void;
  restoreTimeline: (versionIds: string[]) => void;
} {
  const { t } = useTranslation('spriteStudio');
  const [busy, setBusy] = useState(false);

  const deleteVersions = useCallback(async (ids: string[]) => {
    if (ids.length === 0 || busy) return;
    const s = useAnimateSession.getState();
    const inUse = ids.filter((id) => s.frameVersionIds.includes(id));
    const ok = await confirm({
      title: t('frames.deleteTitle'),
      description: inUse.length > 0
        ? t('frames.inUseWarnBody', { n: ids.length, u: inUse.length })
        : t('frames.deleteBody', { n: ids.length }),
      confirmLabel: inUse.length > 0 ? t('frames.inUseRemove') : t('frames.deleteSelected'),
      tone: 'destructive',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await bulkDeleteVersions(projectId, ids);
      const deletedInUse = inUse.filter((id) => res.deleted.includes(id));
      const afterDelete = useAnimateSession.getState();
      if (deletedInUse.length > 0) afterDelete.removeFramesUsing?.(deletedInUse);
      const shortened = res.affectedAnimations.filter((a) => a.removedFrames > 0);
      toast.success(shortened.length > 0
        ? t('frames.deletePartial', { n: res.deleted.length, anim: shortened.map((a) => a.name).join(', ') })
        : t('frames.deleteDone', { n: res.deleted.length }));
      afterDelete.clearSelection();
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, projectId, refresh, t]);

  const addToTimeline = useCallback((orderedIds: string[]) => {
    const s = useAnimateSession.getState();
    if (!s.appendToTimeline) { toast.error(t('frames.needAnimation')); return; }
    const ordered = orderedIds.filter((id) => s.selected.has(id));
    if (ordered.length === 0) return;
    s.appendToTimeline(ordered);
    s.clearSelection();
    toast.success(t('frames.addedToTimeline', { n: ordered.length }));
  }, [t]);

  // Restore a whole batch: replace the open animation's timeline with it.
  const restoreTimeline = useCallback((versionIds: string[]) => {
    const s = useAnimateSession.getState();
    if (!s.setTimeline) { toast.error(t('frames.needAnimation')); return; }
    if (versionIds.length === 0) return;
    s.setTimeline(versionIds);
    toast.success(t('frames.restored', { n: versionIds.length }));
  }, [t]);

  return { busy, deleteVersions, addToTimeline, restoreTimeline };
}
