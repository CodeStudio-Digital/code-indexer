import React from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, CheckSquare, Users, Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import type { KanbanCardFull } from '@mcp/company/types.js';

const TAG_COLORS: Record<string, string> = {
  bug: 'bg-red-500/20 text-red-400 border-red-500/30',
  feature: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  refactor: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  documentation: 'bg-green-500/20 text-green-400 border-green-500/30',
};

interface KanbanCardItemProps {
  card: KanbanCardFull;
  onClick: () => void;
  /**
   * Pipeline-computed priority score (0..something positive after the
   * weighted-sum normalization). Only displayed when the user has
   * recomputed priorities at least once this session.
   */
  priorityScore?: number;
}

/** Convert a normalized priority score into a 1-5 dot rating. */
function scoreToDots(score: number): number {
  if (score >= 2.0) return 5;
  if (score >= 1.5) return 4;
  if (score >= 1.0) return 3;
  if (score >= 0.5) return 2;
  return 1;
}

export const KanbanCardItem = React.memo(function KanbanCardItem({ card, onClick, priorityScore }: KanbanCardItemProps) {
  const { t } = useTranslation('agents');
  const checkedCount = card.checklist.filter((i) => i.checked).length;
  const totalChecklist = card.checklist.length;
  const isBlocked = card.blocked_by.length > 0;
  const activeAgents = card.agents.filter((a) => !a.unassigned_at);

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(card.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onClick}
      className={`
        group relative rounded-lg border bg-card p-3 cursor-pointer transition-all
        hover:border-primary/40 hover:shadow-md
        ${isBlocked ? 'border-red-500/40 opacity-80' : 'border-border'}
      `}
    >
      {/* Blocked indicator */}
      {isBlocked && (
        <div className="absolute -top-1.5 -right-1.5 rounded-full bg-red-500 p-0.5">
          <Lock className="h-3 w-3 text-white" />
        </div>
      )}

      {/* Priority badge (top-right, only when computed). Dot rating so it's
          glanceable; tooltip shows the raw score for the curious. */}
      {priorityScore !== undefined && (
        <div
          className="absolute top-2 right-2 flex items-center gap-0.5 text-[10px] text-amber-400"
          title={`Priority score: ${priorityScore.toFixed(3)}`}
        >
          <Sparkles className="h-3 w-3" />
          <span>{'•'.repeat(scoreToDots(priorityScore))}</span>
        </div>
      )}

      {/* Title */}
      <h4 className="text-sm font-medium leading-tight mb-1.5 pr-12 line-clamp-2">
        {card.title}
      </h4>

      {/* Description preview */}
      {card.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
          {card.description}
        </p>
      )}

      {/* Bottom row: tag + checklist + agents */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Tag badge */}
        {card.tag && (
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${TAG_COLORS[card.tag] ?? ''}`}>
            {card.tag}
          </Badge>
        )}

        {/* Checklist progress */}
        {totalChecklist > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <CheckSquare className="h-3 w-3" />
            {checkedCount}/{totalChecklist}
          </span>
        )}

        {/* Active agent count */}
        {activeAgents.length > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground ml-auto">
            <Users className="h-3 w-3" />
            {activeAgents.map((a) => a.role).join(', ')}
          </span>
        )}

        {/* Comment count */}
        {card.comments.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {t('kanban.card.commentCount', { count: card.comments.length })}
          </span>
        )}
      </div>
    </div>
  );
});
