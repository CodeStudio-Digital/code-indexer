import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkBoardColumn } from '../../components/work-board/index.js';
import { KanbanCardItem } from './KanbanCardItem.js';
import type { KanbanCardFull, KanbanColumn as KanbanColumnType } from '@mcp/company/types.js';

const COLUMN_LABEL_KEYS: Record<KanbanColumnType, string> = {
  backlog: 'kanban.columns.backlog',
  todo: 'kanban.columns.todo',
  in_progress: 'kanban.columns.inProgress',
  review: 'kanban.columns.review',
  done: 'kanban.columns.done',
};

const COLUMN_COLORS: Record<KanbanColumnType, string> = {
  backlog: 'border-t-muted-foreground/40',
  todo: 'border-t-blue-500',
  in_progress: 'border-t-yellow-500',
  review: 'border-t-purple-500',
  done: 'border-t-green-500',
};

interface KanbanColumnProps {
  column: KanbanColumnType;
  cards: KanbanCardFull[];
  onCardClick: (card: KanbanCardFull) => void;
  onDrop: (cardId: string, column: KanbanColumnType) => void;
  onCreateCard?: (column: KanbanColumnType) => void;
  /**
   * Optional priority scores per card id, populated after Recompute
   * Priorities runs. When provided, cards are sorted DESC by score
   * within the column instead of by `position`.
   */
  priorityScores?: Map<string, number>;
  /** C3 — WIP limit for this column (autonomy.wipLimits). Null/undefined = none. */
  wipLimit?: number | null;
  /** C3 — commit a new WIP limit (null removes it). Enables the inline editor. */
  onWipLimitChange?: (column: KanbanColumnType, limit: number | null) => void;
  /** C3 — role suggestions per card id (suggest-roles endpoint). */
  roleSuggestions?: Map<string, string>;
  /** C3 — quick-dispatch a card with its suggested role. */
  onQuickDispatch?: (cardId: string, role: string) => void;
  /** Card ids with a dispatch POST in flight. */
  dispatchingCardIds?: Set<string>;
  /** C3 — open ANY card's modal by id (blocked_by chips). */
  onOpenCardById?: (cardId: string) => void;
  /** Resolve a card title across the whole board (blocked_by chips). */
  titleForCard?: (cardId: string) => string | undefined;
}

export const KanbanColumn = React.memo(function KanbanColumn({
  column,
  cards,
  onCardClick,
  onDrop,
  onCreateCard,
  priorityScores,
  wipLimit,
  onWipLimitChange,
  roleSuggestions,
  onQuickDispatch,
  dispatchingCardIds,
  onOpenCardById,
  titleForCard,
}: KanbanColumnProps) {
  const { t } = useTranslation('agents');
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  // When priority scores are present, sort by score desc (tiebreak: position).
  const sorted = priorityScores && priorityScores.size > 0
    ? [...cards].sort((a, b) => {
        const sa = priorityScores.get(a.id) ?? -Infinity;
        const sb = priorityScores.get(b.id) ?? -Infinity;
        if (sb !== sa) return sb - sa;
        return a.position - b.position;
      })
    : [...cards].sort((a, b) => a.position - b.position);
  const columnLabel = t(COLUMN_LABEL_KEYS[column]);
  const hasLimit = typeof wipLimit === 'number' && wipLimit > 0;
  const overLimit = hasLimit && cards.length > (wipLimit as number);

  const commitLimit = (): void => {
    if (limitDraft == null) return;
    const n = parseInt(limitDraft, 10);
    // 0 / empty / invalid → remove the limit (soft contract with the PATCH).
    onWipLimitChange?.(column, Number.isInteger(n) && n > 0 ? n : null);
    setLimitDraft(null);
  };

  const headerBadge = limitDraft != null ? (
            <input
              autoFocus
              type="number"
              min={0}
              value={limitDraft}
              onChange={(e) => setLimitDraft(e.target.value)}
              onBlur={commitLimit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLimit();
                if (e.key === 'Escape') setLimitDraft(null);
              }}
              onClick={(e) => e.stopPropagation()}
              title={t('kanban.wip.editTooltip')}
              className="w-12 rounded border bg-background px-1 py-0 text-[10px]"
            />
          ) : (
            <button
              onClick={() => {
                if (onWipLimitChange) setLimitDraft(hasLimit ? String(wipLimit) : '');
              }}
              title={
                onWipLimitChange
                  ? (overLimit
                      ? t('kanban.wip.exceededTooltip', { count: cards.length, limit: wipLimit })
                      : t('kanban.wip.editTooltip'))
                  : undefined
              }
              className={`text-xs rounded-full px-1.5 py-0.5 transition-colors ${
                overLimit
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                  : 'text-muted-foreground bg-muted'
              } ${onWipLimitChange ? 'hover:ring-1 hover:ring-primary/40 cursor-pointer' : 'cursor-default'}`}
            >
              {hasLimit ? `${cards.length}/${wipLimit}` : cards.length}
            </button>
          );
  return (
    <WorkBoardColumn
      title={columnLabel}
      count={cards.length}
      accentClass={COLUMN_COLORS[column]}
      headerBadge={headerBadge}
      emptyLabel={t('kanban.dropHere')}
      onAdd={onCreateCard ? () => onCreateCard(column) : undefined}
      onDropItem={(cardId) => { if (cardId) onDrop(cardId, column); }}
    >
        {sorted.map((card) => {
          const suggestedRole = roleSuggestions?.get(card.id);
          return (
            <KanbanCardItem
              key={card.id}
              card={card}
              onClick={() => onCardClick(card)}
              priorityScore={priorityScores?.get(card.id)}
              suggestedRole={suggestedRole}
              onQuickDispatch={
                suggestedRole && onQuickDispatch
                  ? () => onQuickDispatch(card.id, suggestedRole)
                  : undefined
              }
              dispatching={dispatchingCardIds?.has(card.id)}
              onOpenCardById={onOpenCardById}
              titleForCard={titleForCard}
            />
          );
        })}

    </WorkBoardColumn>
  );
});
