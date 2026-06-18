/**
 * Dados do painel de Local History: lista de revisões, conteúdo da revisão
 * selecionada vs. disco atual, restore e label. Restore re-lê o disco e
 * recarrega a lista (a captura do estado pré-restore vira nova revisão).
 */
import { useCallback, useEffect, useState } from 'react';
import { apiCall } from '../../../lib/api-client.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import type { HistoryRevision } from '../../../state/local-history-store.js';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useHistoryData(projectId: number, path: string) {
  const [revisions, setRevisions] = useState<HistoryRevision[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [oldContent, setOldContent] = useState<string | null>(null);
  const [currentContent, setCurrentContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await apiCall<{ revisions: HistoryRevision[] }>('files.historyList', { projectId, path });
    setRevisions(res.revisions);
    setSelectedId((prev) => (prev && res.revisions.some((r) => r.id === prev) ? prev : (res.revisions[0]?.id ?? null)));
  }, [projectId, path]);

  const loadCurrent = useCallback(async () => {
    try {
      const r = await apiCall<{ content: string } | { notModified: true }>('files.read', { projectId, path });
      setCurrentContent('content' in r ? r.content : '');
    } catch {
      setCurrentContent(''); // arquivo deletado → diff mostra tudo removido
    }
  }, [projectId, path]);

  useEffect(() => {
    void reload();
    void loadCurrent();
  }, [reload, loadCurrent]);

  useEffect(() => {
    if (selectedId == null) {
      setOldContent(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiCall<{ rev: HistoryRevision; content: string | null }>('files.historyGet', { projectId, id: selectedId })
      .then((r) => { if (!cancelled) setOldContent(r.content ?? ''); })
      .catch(() => { if (!cancelled) setOldContent(''); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, selectedId]);

  const restore = useCallback(
    async (id: number) => {
      setBusy(true);
      try {
        await apiCall('files.historyRestore', { projectId, id });
        await Promise.all([loadCurrent(), reload()]);
        toast.success('Restored');
      } catch (e) {
        toast.error('Restore failed', { description: msg(e) });
      } finally {
        setBusy(false);
      }
    },
    [projectId, loadCurrent, reload],
  );

  const label = useCallback(
    async (id: number, value: string) => {
      try {
        await apiCall('files.historyLabel', { projectId, id, label: value });
        await reload();
      } catch (e) {
        toast.error('Label failed', { description: msg(e) });
      }
    },
    [projectId, reload],
  );

  const selected = revisions.find((r) => r.id === selectedId) ?? null;
  return { revisions, selectedId, setSelectedId, selected, oldContent, currentContent, loading, busy, restore, label };
}
