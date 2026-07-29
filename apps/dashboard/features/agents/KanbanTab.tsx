import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Loader2, Sparkles, X } from 'lucide-react';
import { KanbanColumn } from './KanbanColumn.js';
import { KanbanCardModal } from './KanbanCardModal.js';
import { useKanbanState } from './useKanbanState.js';
import { Button } from '../../components/ui/button.js';
import { WorkBoardToolbar, WorkBoardViewport } from '../../components/work-board/index.js';
import { Input } from '../../components/ui/input.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import type {
  KanbanCardFull,
  KanbanColumn as KanbanColumnType,
  KanbanTag,
} from '@mcp/company/types.js';
import { KANBAN_COLUMNS } from '@mcp/company/types.js';
import {
  dispatchKanbanCard,
  recomputeKanbanPriorities,
  suggestKanbanRoles,
  type KanbanPriorityDiagnostic,
} from './recommendations-api.js';
import { kanbanRecomputeFingerprint } from './kanban-card-flags.js';
import { RecommendRoleDialog } from './RecommendRoleDialog.js';
import { apiPatch } from '../../hooks/useApi.js';
import { selectAutonomy, useCompanyStore } from '../../state/company/index.js';
import type { AutonomyConfigLike } from '../../state/company/index.js';

interface KanbanTabProps {
  companySessionId: string;
}

/** Debounce for the auto recompute + role-suggestion refresh (C3). */
const AUTO_RECOMPUTE_DEBOUNCE_MS = 1_500;

const autoRecomputeStorageKey = (sessionId: string): string =>
  `mcp.kanban.autoRecompute.${sessionId}`;

export function KanbanTab({ companySessionId }: KanbanTabProps) {
  const { t } = useTranslation(['agents', 'common']);
  const kanban = useKanbanState(companySessionId);
  const [selectedCard, setSelectedCard] = useState<KanbanCardFull | null>(null);
  const [createDialog, setCreateDialog] = useState<{ open: boolean; column: KanbanColumnType }>({
    open: false,
    column: 'backlog',
  });
  const [newTitle, setNewTitle] = useState('');
  const [newTag, setNewTag] = useState<KanbanTag | ''>('');
  // Priority-pipeline state — populated when the user clicks "Recompute
  // priorities" (or the auto refresh runs). Cards display badges + columns
  // sort by score until the user clears it.
  const [priorityDiag, setPriorityDiag] = useState<KanbanPriorityDiagnostic[] | null>(null);
  const [priorityLoading, setPriorityLoading] = useState(false);
  const [priorityError, setPriorityError] = useState<string | null>(null);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [recommendTask, setRecommendTask] = useState('');
  // C3 — auto recompute toggle (persisted), role suggestions, quick dispatch.
  const [autoRecompute, setAutoRecompute] = useState<boolean>(() => {
    try { return localStorage.getItem(autoRecomputeStorageKey(companySessionId)) !== '0'; }
    catch { return true; }
  });
  const [roleSuggestions, setRoleSuggestions] = useState<Map<string, string>>(new Map());
  const [dispatchingIds, setDispatchingIds] = useState<Set<string>>(new Set());
  const [dispatchNotice, setDispatchNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // C3 — WIP limits live in the session autonomy config.
  const autonomyState = useCompanyStore((s) => selectAutonomy(s, companySessionId));
  const autonomyHydrate = useCompanyStore((s) => s.autonomyHydrate);
  const autonomySetConfig = useCompanyStore((s) => s.autonomySetConfig);

  const priorityScores = useMemo(() => {
    if (!priorityDiag) return undefined;
    const m = new Map<string, number>();
    for (const d of priorityDiag) m.set(d.id, d.score);
    return m;
  }, [priorityDiag]);

  const handleRecomputePriorities = useCallback(async () => {
    setPriorityLoading(true);
    setPriorityError(null);
    try {
      const result = await recomputeKanbanPriorities(companySessionId);
      setPriorityDiag(result.diagnostics);
    } catch (e) {
      setPriorityError((e as Error).message);
    } finally {
      setPriorityLoading(false);
    }
  }, [companySessionId]);

  const loadSuggestions = useCallback(async () => {
    try {
      const suggestions = await suggestKanbanRoles(companySessionId);
      setRoleSuggestions(new Map(suggestions.map((s) => [s.cardId, s.role])));
    } catch { /* suggestions are best-effort */ }
  }, [companySessionId]);

  // ─── C3: debounced auto refresh on board mutations ──────────
  // Keyed off a content fingerprint (id/column/deps/agents/title) so
  // unrelated churn (comments, checklist) doesn't re-run the pipelines and
  // the read-only recompute response can never re-trigger itself.
  const fingerprint = useMemo(
    () => kanbanRecomputeFingerprint(kanban.cards),
    [kanban.cards],
  );
  useEffect(() => {
    if (!autoRecompute || kanban.loading || kanban.cards.length === 0) return;
    const timer = setTimeout(() => {
      void handleRecomputePriorities();
      void loadSuggestions();
    }, AUTO_RECOMPUTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fingerprint, autoRecompute, kanban.loading, kanban.cards.length, handleRecomputePriorities, loadSuggestions]);

  const toggleAutoRecompute = useCallback(() => {
    setAutoRecompute((prev) => {
      const next = !prev;
      try { localStorage.setItem(autoRecomputeStorageKey(companySessionId), next ? '1' : '0'); }
      catch { /* private mode */ }
      return next;
    });
  }, [companySessionId]);

  // ─── C3: quick dispatch (suggestion chip click) ─────────────
  const handleQuickDispatch = useCallback(async (cardId: string, role: string) => {
    setDispatchingIds((prev) => new Set(prev).add(cardId));
    try {
      const res = await dispatchKanbanCard(companySessionId, cardId, role);
      if (res.ok) {
        setDispatchNotice({
          kind: 'ok',
          text: t('agents:kanban.dispatch.success', { role: res.role ?? role, run: res.agentRunId ?? '?', cardId }),
        });
        setRoleSuggestions((prev) => { const m = new Map(prev); m.delete(cardId); return m; });
      } else {
        setDispatchNotice({
          kind: 'err',
          text: t('agents:kanban.dispatch.failed', { reason: res.reason ?? res.error ?? '?' }),
        });
      }
    } catch (e) {
      setDispatchNotice({
        kind: 'err',
        text: t('agents:kanban.dispatch.failed', { reason: (e as Error).message }),
      });
    } finally {
      setDispatchingIds((prev) => { const s = new Set(prev); s.delete(cardId); return s; });
    }
  }, [companySessionId, t]);

  // Toast substitute (no toast infra in the dashboard): auto-hide banner.
  useEffect(() => {
    if (!dispatchNotice) return;
    const timer = setTimeout(() => setDispatchNotice(null), 5_000);
    return () => clearTimeout(timer);
  }, [dispatchNotice]);

  // ─── C3: WIP limits (autonomy config) ───────────────────────
  const refetchAutonomy = useCallback(async () => {
    try {
      const r = await fetch(`/api/company/sessions/${companySessionId}/autonomy`);
      if (!r.ok) return;
      const body = (await r.json().catch(() => null)) as { config?: AutonomyConfigLike | null } | null;
      if (body) autonomyHydrate(companySessionId, { config: body.config ?? null, events: [] });
    } catch { /* keep last-known */ }
  }, [companySessionId, autonomyHydrate]);

  useEffect(() => {
    if (!autonomyState.initialized) void refetchAutonomy();
  }, [autonomyState.initialized, refetchAutonomy]);

  const wipLimits = autonomyState.config?.wipLimits ?? {};

  const handleWipLimitChange = useCallback(async (column: KanbanColumnType, limit: number | null) => {
    const next: Record<string, number> = { ...(autonomyState.config?.wipLimits ?? {}) };
    if (limit == null) delete next[column];
    else next[column] = limit;
    // Optimistic — the config PATCH round-trips through sanitize + merge.
    autonomySetConfig(companySessionId, { ...(autonomyState.config ?? {}), wipLimits: next });
    try {
      await apiPatch(`/company/sessions/${companySessionId}/config`, { autonomy: { wipLimits: next } });
    } catch {
      await refetchAutonomy(); // reconcile on rejection
    }
  }, [companySessionId, autonomyState.config, autonomySetConfig, refetchAutonomy]);

  // Group cards by column
  const cardsByColumn = new Map<KanbanColumnType, KanbanCardFull[]>();
  for (const col of KANBAN_COLUMNS) cardsByColumn.set(col, []);
  for (const card of kanban.cards) {
    const list = cardsByColumn.get(card.column) ?? [];
    list.push(card);
    cardsByColumn.set(card.column, list);
  }

  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of kanban.cards) m.set(c.id, c.title);
    return m;
  }, [kanban.cards]);

  const handleDrop = useCallback(
    (cardId: string, column: KanbanColumnType) => {
      kanban.moveCard(cardId, column);
    },
    [kanban.moveCard],
  );

  const handleCardClick = useCallback((card: KanbanCardFull) => {
    setSelectedCard(card);
  }, []);

  // C3 — blocked_by chips open the BLOCKER's modal.
  const handleOpenCardById = useCallback((cardId: string) => {
    const card = kanban.cards.find((c) => c.id === cardId);
    if (card) setSelectedCard(card);
  }, [kanban.cards]);

  const handleCreateCard = useCallback(
    (column: KanbanColumnType) => {
      setCreateDialog({ open: true, column });
      setNewTitle('');
      setNewTag('');
    },
    [],
  );

  const handleCreateSubmit = useCallback(async () => {
    if (!newTitle.trim()) return;
    await kanban.createCard({
      title: newTitle.trim(),
      column: createDialog.column,
      tag: newTag || undefined,
    });
    setCreateDialog({ open: false, column: 'backlog' });
  }, [newTitle, newTag, createDialog.column, kanban.createCard]);

  // Keep selectedCard in sync with kanban state
  const activeCard = selectedCard
    ? kanban.cards.find((c) => c.id === selectedCard.id) ?? selectedCard
    : null;

  if (kanban.loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Error banner */}
      {kanban.error && (
        <div className="mx-3 mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
          {kanban.error}
        </div>
      )}
      {priorityError && (
        <div className="mx-3 mt-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-sm text-amber-400">
          Priority recompute failed: {priorityError}
        </div>
      )}
      {dispatchNotice && (
        <div
          className={`mx-3 mt-2 p-2 rounded text-sm border ${
            dispatchNotice.kind === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}
        >
          {dispatchNotice.text}
        </div>
      )}

      {/* Toolbar: priority pipeline trigger + auto toggle + clear */}
      <WorkBoardToolbar>
        <Button
          size="sm"
          variant={priorityScores ? 'default' : 'outline'}
          onClick={() => void handleRecomputePriorities()}
          disabled={priorityLoading}
        >
          {priorityLoading ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3 mr-1" />
          )}
          {priorityScores ? 'Refresh priorities' : 'Recompute priorities'}
        </Button>
        <Button
          size="sm"
          variant={autoRecompute ? 'secondary' : 'ghost'}
          onClick={toggleAutoRecompute}
          title={t('agents:kanban.autoRecomputeTooltip')}
        >
          {t('agents:kanban.autoRecompute')}
        </Button>
        {priorityScores && (
          <Button size="sm" variant="ghost" onClick={() => setPriorityDiag(null)}>
            <X className="h-3 w-3 mr-1" /> Clear
          </Button>
        )}
        {priorityScores && (
          <span className="text-muted-foreground">
            {priorityScores.size} cards ranked — columns sorted by score
          </span>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRecommendTask('');
            setRecommendOpen(true);
          }}
        >
          <Sparkles className="h-3 w-3 mr-1" /> Recommend role
        </Button>
      </WorkBoardToolbar>

      {/* Columns */}
      <WorkBoardViewport>
          {KANBAN_COLUMNS.map((col) => (
            <KanbanColumn
              key={col}
              column={col}
              cards={cardsByColumn.get(col) ?? []}
              onCardClick={handleCardClick}
              onDrop={handleDrop}
              onCreateCard={handleCreateCard}
              priorityScores={priorityScores}
              wipLimit={(wipLimits as Record<string, number>)[col] ?? null}
              onWipLimitChange={(column, limit) => void handleWipLimitChange(column, limit)}
              roleSuggestions={roleSuggestions}
              onQuickDispatch={(cardId, role) => void handleQuickDispatch(cardId, role)}
              dispatchingCardIds={dispatchingIds}
              onOpenCardById={handleOpenCardById}
              titleForCard={(id) => titleById.get(id)}
            />
          ))}
      </WorkBoardViewport>

      {/* Card detail modal */}
      {activeCard && (
        <KanbanCardModal
          card={activeCard}
          allCards={kanban.cards}
          open={!!activeCard}
          onClose={() => setSelectedCard(null)}
          onUpdate={kanban.updateCard}
          onAddComment={kanban.addComment}
          onAddChecklistItem={kanban.addChecklistItem}
          onUpdateChecklistItem={kanban.updateChecklistItem}
          onAddDependency={kanban.addDependency}
          onRemoveDependency={kanban.removeDependency}
          onDelete={kanban.deleteCard}
        />
      )}

      {/* Create card dialog */}
      <Dialog
        open={createDialog.open}
        onOpenChange={(v) => !v && setCreateDialog({ open: false, column: 'backlog' })}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('agents:kanban.newCard')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder={t('agents:kanban.cardTitlePlaceholder')}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateSubmit()}
              autoFocus
            />
            <div className="flex gap-1">
              {(['bug', 'feature', 'refactor', 'documentation'] as KanbanTag[]).map((tag) => (
                <button
                  key={tag}
                  onClick={() => setNewTag(newTag === tag ? '' : tag)}
                  className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                    newTag === tag
                      ? 'bg-primary/20 border-primary text-primary'
                      : 'border-border text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreateDialog({ open: false, column: 'backlog' })}
              >
                {t('common:actions.cancel')}
              </Button>
              <Button size="sm" disabled={!newTitle.trim()} onClick={handleCreateSubmit}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('common:actions.create')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Recommend role dialog (PR12 — RolePipeline integration) */}
      <RecommendRoleDialog
        sessionId={companySessionId}
        open={recommendOpen}
        onClose={() => setRecommendOpen(false)}
        initialTask={recommendTask}
      />
    </div>
  );
}
