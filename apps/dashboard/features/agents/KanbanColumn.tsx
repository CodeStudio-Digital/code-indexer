import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
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
  onDrop: (cardId: number, column: KanbanColumnType) => void;
  onCreateCard?: (column: KanbanColumnType) => void;
  /**
   * Optional priority scores per card id, populated after Recompute
   * Priorities runs. When provided, cards are sorted DESC by score
   * within the column instead of by `position`.
   */
  priorityScores?: Map<number, number>;
}

export const KanbanColumn = React.memo(function KanbanColumn({
  column,
  cards,
  onCardClick,
  onDrop,
  onCreateCard,
  priorityScores,
}: KanbanColumnProps) {
  const { t } = useTranslation('agents');
  const [dragOver, setDragOver] = useState(false);
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

  return (
    <div
      className={`
        flex flex-col min-w-[260px] max-w-[300px] flex-1
        rounded-lg bg-muted/30 border border-t-2 ${COLUMN_COLORS[column]}
        ${dragOver ? 'ring-2 ring-primary/40 bg-primary/5' : ''}
      `}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const cardId = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(cardId)) onDrop(cardId, column);
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{columnLabel}</h3>
          <span className="text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5">
            {cards.length}
          </span>
        </div>
        {onCreateCard && (
          <button
            onClick={() => onCreateCard(column)}
            className="p-1 rounded hover:bg-muted transition-colors"
            title={t('kanban.addCardTo', { column: columnLabel })}
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px]">
        {sorted.map((card) => (
          <KanbanCardItem
            key={card.id}
            card={card}
            onClick={() => onCardClick(card)}
            priorityScore={priorityScores?.get(card.id)}
          />
        ))}

        {cards.length === 0 && (
          <div className="flex items-center justify-center h-16 text-xs text-muted-foreground/60">
            {t('kanban.dropHere')}
          </div>
        )}
      </div>
    </div>
  );
});
