import { useApiClient } from './useApiClient.js';
import { useTranslation } from 'react-i18next';
/**
 * API client tab — an in-app Postman over the project's persisted collections.
 * Three resizable panes (collection list · request editor · response viewer)
 * plus a toolbar for the active environment. Mounted both in the project IDE
 * (ProjectView) and inside the company API tab.
 */
import { useCallback, useEffect } from 'react';
import { toast, confirm } from '../../components/ui/prompt-dialog.js';
import { isRequestDeleteUndoShortcut } from './request-delete-undo.js';

export function useRequestDeletion(c: ReturnType<typeof useApiClient>, t: ReturnType<typeof useTranslation<'apiClient'>>['t']) {
const { state } = c;
  const removeRequestGuarded = useCallback(async (requestId: number) => {
    const request = state.requests.find((candidate) => candidate.id === requestId);
    if (!request) return;
    const accepted = await confirm({
      title: t('row.deleteConfirmTitle', { name: request.name }),
      description: t('row.deleteConfirmBody'),
      confirmLabel: t('row.delete'),
      tone: 'destructive',
    });
    if (!accepted) return;
    try {
      await c.removeRequest(requestId);
      toast.info(t('row.deleted'), { description: t('row.deleteUndoHint') });
    } catch (error) {
      toast.error(t('row.deleteFailed'), { description: error instanceof Error ? error.message : String(error) });
    }
  }, [c.removeRequest, state.requests, t]);

  useEffect(() => {
    const undoDeletedRequest = (event: KeyboardEvent) => {
      if (!c.canUndoRequestDelete || !isRequestDeleteUndoShortcut(event)) return;
      event.preventDefault();
      void c.undoLastRequestDelete()
        .then((restored) => {
          if (restored) toast.success(t('row.restored', { name: restored.name }));
        })
        .catch((error) => toast.error(t('row.restoreFailed'), {
          description: error instanceof Error ? error.message : String(error),
        }));
    };
    window.addEventListener('keydown', undoDeletedRequest);
    return () => window.removeEventListener('keydown', undoDeletedRequest);
  }, [c.canUndoRequestDelete, c.undoLastRequestDelete, t]);


return removeRequestGuarded;
}
