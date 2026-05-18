/**
 * Kanban state hook — reads cards from the company store (single source
 * of truth) and exposes REST mutation helpers.
 *
 * Phase 2: SSE is authoritative. Every mutation has a matching backend
 * `kanban_*` broadcast that `kanbanSlice.kanbanApplyEvent` reduces, so
 * the hook no longer refetches after a successful mutation. `refreshCard`
 * stays in the return surface as an escape hatch — `moveCard` uses it to
 * revert when the server rejects with 409 (blocked by deps), and the
 * consumer can call it explicitly if it suspects drift.
 */
import { useCallback, useEffect, useMemo } from 'react';
import type {
  KanbanCardFull,
  KanbanColumn,
  KanbanTag,
} from '@mcp/company-contracts';
import {
  useCompanyStore,
  selectKanban,
} from '../../state/company/index.js';

export interface UseKanbanStateResult {
  cards: KanbanCardFull[];
  loading: boolean;
  error: string | null;
  createCard: (input: {
    title: string;
    description?: string;
    column?: KanbanColumn;
    tag?: KanbanTag;
    checklist?: string[];
  }) => Promise<KanbanCardFull | null>;
  moveCard: (cardId: number, column: KanbanColumn, position?: number) => Promise<boolean>;
  updateCard: (
    cardId: number,
    patch: { title?: string; description?: string; tag?: KanbanTag | null },
  ) => Promise<boolean>;
  deleteCard: (cardId: number) => Promise<boolean>;
  addComment: (cardId: number, content: string) => Promise<boolean>;
  addChecklistItem: (cardId: number, text: string) => Promise<boolean>;
  updateChecklistItem: (itemId: number, patch: { text?: string; checked?: boolean }) => Promise<boolean>;
  addDependency: (cardId: number, dependsOnCardId: number) => Promise<boolean>;
  removeDependency: (cardId: number, dependsOnCardId: number) => Promise<boolean>;
  refreshCard: (cardId: number) => Promise<void>;
}

export function useKanbanState(companySessionId: number | null): UseKanbanStateResult {
  const slot = useCompanyStore((s) => selectKanban(s, companySessionId));
  const kanbanHydrate = useCompanyStore((s) => s.kanbanHydrate);
  const kanbanUpsertCard = useCompanyStore((s) => s.kanbanUpsertCard);
  const kanbanRemoveCard = useCompanyStore((s) => s.kanbanRemoveCard);
  const kanbanSetLoading = useCompanyStore((s) => s.kanbanSetLoading);
  const kanbanSetError = useCompanyStore((s) => s.kanbanSetError);

  // ─── Initial REST load ───────────────────────────────────────
  useEffect(() => {
    if (companySessionId == null) return;
    let cancelled = false;

    async function load(): Promise<void> {
      kanbanSetLoading(companySessionId!, true);
      try {
        const res = await fetch(`/api/company/sessions/${companySessionId}/kanban`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as KanbanCardFull[];
        if (cancelled) return;
        kanbanHydrate(companySessionId!, data);
      } catch (e) {
        if (!cancelled) kanbanSetError(companySessionId!, (e as Error).message);
      } finally {
        if (!cancelled) kanbanSetLoading(companySessionId!, false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [companySessionId, kanbanHydrate, kanbanSetLoading, kanbanSetError]);

  // ─── Derived cards array (stable per render) ─────────────────
  const cards = useMemo(() => Array.from(slot.cards.values()), [slot.cards]);

  const base = companySessionId != null ? `/api/company/sessions/${companySessionId}/kanban` : null;

  // ─── Mutations ───────────────────────────────────────────────

  const refreshCard = useCallback(
    async (cardId: number): Promise<void> => {
      if (companySessionId == null || base == null) return;
      try {
        const res = await fetch(`${base}/${cardId}`);
        if (res.ok) {
          const card = (await res.json()) as KanbanCardFull;
          kanbanUpsertCard(companySessionId, card);
        }
      } catch {
        /* ignore */
      }
    },
    [companySessionId, base, kanbanUpsertCard],
  );

  const createCard = useCallback(
    async (input: {
      title: string;
      description?: string;
      column?: KanbanColumn;
      tag?: KanbanTag;
      checklist?: string[];
    }) => {
      if (companySessionId == null || base == null) return null;
      try {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          kanbanSetError(companySessionId, `Create failed: ${res.status}`);
          return null;
        }
        const card = (await res.json()) as KanbanCardFull;
        kanbanUpsertCard(companySessionId, card);
        return card;
      } catch (e) {
        kanbanSetError(companySessionId, (e as Error).message);
        return null;
      }
    },
    [companySessionId, base, kanbanUpsertCard, kanbanSetError],
  );

  const moveCard = useCallback(
    async (cardId: number, column: KanbanColumn, position?: number): Promise<boolean> => {
      if (companySessionId == null || base == null) return false;
      try {
        const res = await fetch(`${base}/${cardId}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ column, position }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Move failed' }));
          kanbanSetError(companySessionId, body.error ?? `Move failed: ${res.status}`);
          await refreshCard(cardId);
          return false;
        }
        // Backend broadcasts a kanban_card_moved SSE that updates the
        // slice; no need to refetch on success.
        return true;
      } catch (e) {
        kanbanSetError(companySessionId, (e as Error).message);
        return false;
      }
    },
    [companySessionId, base, refreshCard, kanbanSetError],
  );

  const updateCard = useCallback(
    async (
      cardId: number,
      patch: { title?: string; description?: string; tag?: KanbanTag | null },
    ): Promise<boolean> => {
      if (companySessionId == null || base == null) return false;
      try {
        const res = await fetch(`${base}/${cardId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          kanbanSetError(companySessionId, `Update failed: ${res.status}`);
          return false;
        }
        // SSE `kanban_card_updated` updates the slice — no refetch.
        return true;
      } catch (e) {
        kanbanSetError(companySessionId, (e as Error).message);
        return false;
      }
    },
    [companySessionId, base, kanbanSetError],
  );

  const deleteCard = useCallback(
    async (cardId: number): Promise<boolean> => {
      if (companySessionId == null || base == null) return false;
      try {
        const res = await fetch(`${base}/${cardId}`, { method: 'DELETE' });
        if (!res.ok) {
          kanbanSetError(companySessionId, `Delete failed: ${res.status}`);
          return false;
        }
        kanbanRemoveCard(companySessionId, cardId);
        return true;
      } catch (e) {
        kanbanSetError(companySessionId, (e as Error).message);
        return false;
      }
    },
    [companySessionId, base, kanbanRemoveCard, kanbanSetError],
  );

  const addComment = useCallback(
    async (cardId: number, content: string): Promise<boolean> => {
      if (companySessionId == null || base == null) return false;
      try {
        const res = await fetch(`${base}/${cardId}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        // SSE `kanban_comment_added` updates the slice — no refetch.
        return res.ok;
      } catch {
        return false;
      }
    },
    [companySessionId, base],
  );

  const addChecklistItem = useCallback(
    async (cardId: number, text: string): Promise<boolean> => {
      if (companySessionId == null || base == null) return false;
      try {
        const res = await fetch(`${base}/${cardId}/checklist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        // SSE `kanban_checklist_updated` updates the slice — no refetch.
        return res.ok;
      } catch {
        return false;
      }
    },
    [companySessionId, base],
  );

  const updateChecklistItem = useCallback(
    async (itemId: number, patch: { text?: string; checked?: boolean }): Promise<boolean> => {
      if (companySessionId == null) return false;
      try {
        const res = await fetch(
          `/api/company/sessions/${companySessionId}/kanban/checklist/${itemId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          },
        );
        return res.ok;
      } catch {
        return false;
      }
    },
    [companySessionId],
  );

  const addDependency = useCallback(
    async (cardId: number, dependsOnCardId: number): Promise<boolean> => {
      if (companySessionId == null || base == null) return false;
      try {
        const res = await fetch(`${base}/${cardId}/dependencies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depends_on_card_id: dependsOnCardId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Failed' }));
          kanbanSetError(companySessionId, body.error);
          return false;
        }
        // SSE `kanban_dependency_added` updates the slice — no refetch.
        return true;
      } catch (e) {
        kanbanSetError(companySessionId, (e as Error).message);
        return false;
      }
    },
    [companySessionId, base, kanbanSetError],
  );

  const removeDependency = useCallback(
    async (cardId: number, dependsOnCardId: number): Promise<boolean> => {
      if (companySessionId == null || base == null) return false;
      try {
        const res = await fetch(`${base}/${cardId}/dependencies/${dependsOnCardId}`, {
          method: 'DELETE',
        });
        // SSE `kanban_dependency_removed` updates the slice — no refetch.
        return res.ok;
      } catch {
        return false;
      }
    },
    [companySessionId, base, refreshCard],
  );

  return {
    cards,
    loading: slot.loading,
    error: slot.error,
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
