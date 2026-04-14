/**
 * Kanban state hook — fetches initial state from API, merges SSE events,
 * exposes optimistic mutation methods.
 */
import { useCallback, useEffect, useState } from 'react';
import type { KanbanCardFull, KanbanColumn, KanbanTag } from '../../../../core/coder/company/types.js';

export interface UseKanbanStateResult {
  cards: KanbanCardFull[];
  loading: boolean;
  error: string | null;
  createCard: (input: { title: string; description?: string; column?: KanbanColumn; tag?: KanbanTag; checklist?: string[] }) => Promise<KanbanCardFull | null>;
  moveCard: (cardId: number, column: KanbanColumn, position?: number) => Promise<boolean>;
  updateCard: (cardId: number, patch: { title?: string; description?: string; tag?: KanbanTag | null }) => Promise<boolean>;
  deleteCard: (cardId: number) => Promise<boolean>;
  addComment: (cardId: number, content: string) => Promise<boolean>;
  addChecklistItem: (cardId: number, text: string) => Promise<boolean>;
  updateChecklistItem: (itemId: number, patch: { text?: string; checked?: boolean }) => Promise<boolean>;
  addDependency: (cardId: number, dependsOnCardId: number) => Promise<boolean>;
  removeDependency: (cardId: number, dependsOnCardId: number) => Promise<boolean>;
  refreshCard: (cardId: number) => Promise<void>;
}

export function useKanbanState(
  companySessionId: number | null,
  /** SSE-driven kanban cards from useCompanyStream */
  streamCards: Map<number, KanbanCardFull>,
): UseKanbanStateResult {
  const [localCards, setLocalCards] = useState<Map<number, KanbanCardFull>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Fetch initial state from API
  useEffect(() => {
    if (!companySessionId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/company/sessions/${companySessionId}/kanban`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as KanbanCardFull[];
        if (!cancelled) {
          const m = new Map<number, KanbanCardFull>();
          for (const c of data) m.set(c.id, c);
          setLocalCards(m);
          setInitialized(true);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [companySessionId]);

  // Merge SSE stream cards into local state
  useEffect(() => {
    if (!initialized) return;
    setLocalCards((prev) => {
      const merged = new Map(prev);
      for (const [id, card] of streamCards) {
        merged.set(id, card);
      }
      // Remove cards that were deleted via SSE (present in local but not in stream AND were in stream before)
      // This is handled by the delete event in useCompanyStream already
      return merged;
    });
  }, [streamCards, initialized]);

  // Build sorted array from the map
  const cards = Array.from(localCards.values());

  const base = `/api/company/sessions/${companySessionId}/kanban`;

  const createCard = useCallback(async (input: { title: string; description?: string; column?: KanbanColumn; tag?: KanbanTag; checklist?: string[] }) => {
    if (!companySessionId) return null;
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) { setError(`Create failed: ${res.status}`); return null; }
      const card = await res.json() as KanbanCardFull;
      setLocalCards((prev) => new Map(prev).set(card.id, card));
      return card;
    } catch (e) { setError((e as Error).message); return null; }
  }, [companySessionId]);

  const moveCard = useCallback(async (cardId: number, column: KanbanColumn, position?: number) => {
    if (!companySessionId) return false;
    // Optimistic update
    setLocalCards((prev) => {
      const m = new Map(prev);
      const card = m.get(cardId);
      if (card) m.set(cardId, { ...card, column, position: position ?? card.position });
      return m;
    });
    try {
      const res = await fetch(`${base}/${cardId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column, position }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Move failed' }));
        setError(body.error ?? `Move failed: ${res.status}`);
        // Revert
        await refreshCard(cardId);
        return false;
      }
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }, [companySessionId]);

  const updateCard = useCallback(async (cardId: number, patch: { title?: string; description?: string; tag?: KanbanTag | null }) => {
    if (!companySessionId) return false;
    try {
      const res = await fetch(`${base}/${cardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) { setError(`Update failed: ${res.status}`); return false; }
      await refreshCard(cardId);
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }, [companySessionId]);

  const deleteCard = useCallback(async (cardId: number) => {
    if (!companySessionId) return false;
    try {
      const res = await fetch(`${base}/${cardId}`, { method: 'DELETE' });
      if (!res.ok) { setError(`Delete failed: ${res.status}`); return false; }
      setLocalCards((prev) => {
        const m = new Map(prev);
        m.delete(cardId);
        return m;
      });
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }, [companySessionId]);

  const addComment = useCallback(async (cardId: number, content: string) => {
    if (!companySessionId) return false;
    try {
      const res = await fetch(`${base}/${cardId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) return false;
      await refreshCard(cardId);
      return true;
    } catch { return false; }
  }, [companySessionId]);

  const addChecklistItem = useCallback(async (cardId: number, text: string) => {
    if (!companySessionId) return false;
    try {
      const res = await fetch(`${base}/${cardId}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return false;
      await refreshCard(cardId);
      return true;
    } catch { return false; }
  }, [companySessionId]);

  const updateChecklistItem = useCallback(async (itemId: number, patch: { text?: string; checked?: boolean }) => {
    if (!companySessionId) return false;
    try {
      const res = await fetch(`/api/company/sessions/${companySessionId}/kanban/checklist/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      return res.ok;
    } catch { return false; }
  }, [companySessionId]);

  const addDependency = useCallback(async (cardId: number, dependsOnCardId: number) => {
    if (!companySessionId) return false;
    try {
      const res = await fetch(`${base}/${cardId}/dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ depends_on_card_id: dependsOnCardId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed' }));
        setError(body.error);
        return false;
      }
      await refreshCard(cardId);
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }, [companySessionId]);

  const removeDependency = useCallback(async (cardId: number, dependsOnCardId: number) => {
    if (!companySessionId) return false;
    try {
      const res = await fetch(`${base}/${cardId}/dependencies/${dependsOnCardId}`, { method: 'DELETE' });
      if (!res.ok) return false;
      await refreshCard(cardId);
      return true;
    } catch { return false; }
  }, [companySessionId]);

  const refreshCard = useCallback(async (cardId: number) => {
    if (!companySessionId) return;
    try {
      const res = await fetch(`${base}/${cardId}`);
      if (res.ok) {
        const card = await res.json() as KanbanCardFull;
        setLocalCards((prev) => new Map(prev).set(card.id, card));
      }
    } catch { /* ignore */ }
  }, [companySessionId]);

  return {
    cards,
    loading,
    error,
    createCard,
    moveCard,
    updateCard,
    deleteCard,
    addComment,
    addChecklistItem,
    updateChecklistItem,
    addDependency,
    removeDependency,
    refreshCard,
  };
}
