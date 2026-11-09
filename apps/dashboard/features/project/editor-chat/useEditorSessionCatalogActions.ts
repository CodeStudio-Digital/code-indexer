import { useCallback } from 'react';
import { apiPatch, apiPost } from '../../../hooks/useApi.js';
import type { CoderSession, CoderSessionGroup } from '../../chat/types.js';
import { deleteChats } from '../../chat/delete-chats.js';
import { useDeletedSession } from '../../chat/useDeletedSession.js';
interface Options {
  projectId: number;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  refetchSessions: () => void;
  refetchGroups: () => void;
}
export function useEditorSessionCatalogActions({ projectId, selectedId, setSelectedId, refetchSessions, refetchGroups }: Options) {
  useDeletedSession(selectedId, setSelectedId);
  const archiveSession = useCallback(async (id: string, archived = true) => {
    await apiPatch(`/coder/sessions/${id}/archive`, { archived });
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, refetchSessions]);

  const deleteSession = useCallback(async (id: string) => {
    await deleteChats([id]);
    if (selectedId === id) setSelectedId(null);
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, refetchSessions]);

  const favoriteSession = useCallback(async (id: string, favorite: boolean) => {
    await apiPatch(`/coder/sessions/${id}/favorite`, { favorite });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const renameSession = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await apiPatch(`/coder/sessions/${id}/title`, { title: trimmed });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const duplicateSession = useCallback(async (id: string) => {
    const res = await apiPost<{ session: CoderSession }>(`/coder/sessions/${id}/duplicate`, {});
    refetchSessions();
    setSelectedId(res.session.id);
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    return res.session.id;
  }, [refetchSessions]);

  const moveSessionToGroup = useCallback(async (id: string, groupId: string | null) => {
    await apiPatch(`/coder/sessions/${id}/group`, { group_id: groupId });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [refetchSessions]);

  const createGroup = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await apiPost<CoderSessionGroup>('/coder/groups', {
      project_id: projectId,
      name: trimmed,
    });
    refetchGroups();
    refetchSessions();
  }, [projectId, refetchGroups, refetchSessions]);


  return { archiveSession, deleteSession, favoriteSession, renameSession, duplicateSession, moveSessionToGroup, createGroup };
}
