import React from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, CheckSquare, Users, Sparkles, Zap, Loader2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import type { KanbanCardFull } from '@mcp/company/types.js';
import { isAutoDispatched } from './kanban-card-flags.js';
import { WorkBoardCard, WorkBoardCardContent } from '../../components/work-board/index.js';

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
  releaseCount?: number;
  /** C3 — suggested role for this card (suggest-roles endpoint). */
  suggestedRole?: string;
  /** C3 — quick-dispatch this card with the suggested role. */
  onQuickDispatch?: () => void;
  /** True while the quick-dispatch POST for THIS card is in flight. */
  dispatching?: boolean;
  /** C3 — open another card's modal (blocked_by chips). */
  onOpenCardById?: (cardId: string) => void;
  /** Resolve a card title for the blocked_by chips (falls back to #id). */
  titleForCard?: (cardId: string) => string | undefined;
}

/** Convert a normalized priority score into a 1-5 dot rating. */
function scoreToDots(score: number): number {
  if (score >= 2.0) return 5;
  if (score >= 1.5) return 4;
  if (score >= 1.0) return 3;
  if (score >= 0.5) return 2;
  return 1;
}

export const KanbanCardItem = React.memo(function KanbanCardItem({
  card,
  onClick,
  priorityScore,
  releaseCount,
  suggestedRole,
  onQuickDispatch,
  dispatching,
  onOpenCardById,
  titleForCard,
}: KanbanCardItemProps) {
  const { t } = useTranslation('agents');
  const checkedCount = card.checklist.filter((i) => i.checked).length;
  const totalChecklist = card.checklist.length;
  const isBlocked = card.blocked_by.length > 0;
  const activeAgents = card.agents.filter((a) => !a.unassigned_at);
  const autoDispatched = isAutoDispatched(card);
  const showSuggestion =
    !!suggestedRole && !!onQuickDispatch && activeAgents.length === 0 && !isBlocked;

  return (
    <WorkBoardCard dragId={card.id} onClick={onClick} blocked={isBlocked}>
      <WorkBoardCardContent
        title={card.title}
        description={[card.control?.owner && '@'+card.control.owner,card.control?.projectId && '#'+card.control.projectId,card.description].filter(Boolean).join(' · ') || undefined}
        trailing={priorityScore !== undefined ? (
          <div className="flex shrink-0 items-center gap-0.5 text-[10px] text-amber-400" title={releaseCount ? t('designer.blocksCount',{count:releaseCount}) : t('kanban.card.priorityScore', { score: priorityScore.toFixed(3) })}>
            <Sparkles className="h-3 w-3" /><span>{'•'.repeat(scoreToDots(priorityScore))}</span>
          </div>
        ) : undefined}
      />

      {/* Blocked-by chips — clickable, open the blocker's modal (C3). */}
      {isBlocked && (
        <div className="flex items-center gap-1 flex-wrap mb-1.5">
          {card.blocked_by.map((blockerId) => (
            <button
              key={blockerId}
              onClick={(e) => {
                e.stopPropagation();
                onOpenCardById?.(blockerId);
              }}
              title={t('kanban.card.blockedByTooltip', { id: blockerId })}
              className="flex items-center gap-1 max-w-[140px] text-[10px] px-1.5 py-0.5 rounded-full
                border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <Lock className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">
                #{blockerId}{titleForCard?.(blockerId) ? ` ${titleForCard(blockerId)}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Bottom row: tag + auto/suggestion chips + checklist + agents */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* AUTO chip — this card was dispatched by the autonomous scheduler. */}
        {autoDispatched && (
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 gap-1 bg-primary/15 text-primary border-primary/30"
            title={t('kanban.card.autoDispatchedTooltip')}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            {t('kanban.card.autoChip')}
          </Badge>
        )}

        {/* Suggested-role chip — click = quick-dispatch with that role (C3). */}
        {showSuggestion && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!dispatching) onQuickDispatch?.();
            }}
            disabled={dispatching}
            title={t('kanban.card.suggestedRoleTooltip', { role: suggestedRole })}
            className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full
              border border-violet-500/40 bg-violet-500/10 text-violet-400
              hover:bg-violet-500/25 transition-colors disabled:opacity-60"
          >
            {dispatching
              ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
              : <Zap className="h-2.5 w-2.5" />}
            @{suggestedRole}
          </button>
        )}

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
    </WorkBoardCard>
  );
});
