import React, { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Zap, HelpCircle, Package, ArrowRightLeft } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import { Markdown } from '../chat/messages/Markdown.js';
import type { BoardMessage } from '../../hooks/useCompanyStream.js';
import type { MasterPrompt } from '../../../../core/coder/company/types.js';
import { MasterPromptCard } from './MasterPromptCard.js';

const KIND_ICONS: Record<string, React.FC<{ className?: string }>> = {
  message: MessageSquare,
  decision: Zap,
  question: HelpCircle,
  deliverable: Package,
  handoff: ArrowRightLeft,
};

const ROLE_COLORS: Record<string, string> = {
  master: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  system: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  human: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  frontend: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  backend: 'bg-green-500/20 text-green-400 border-green-500/30',
  backcloudflare: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  nextjs: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
  qa: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  po: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
  reviewer: 'bg-teal-500/20 text-teal-400 border-teal-500/30',
  critic: 'bg-red-500/20 text-red-400 border-red-500/30',
};

function getRoleColor(role: string): string {
  return ROLE_COLORS[role] ?? 'bg-muted text-muted-foreground border-border';
}

interface BoardPanelProps {
  messages: BoardMessage[];
  /**
   * Master↔human prompts (ask_user / submit_plan). Rendered inline in the
   * feed in chronological order with the regular board messages so the
   * full conversation reads top-to-bottom, including answered and
   * cancelled entries as part of the permanent history.
   */
  masterPrompts?: MasterPrompt[];
  onAnswerQuestion?: (promptId: number, answer: string) => void;
  onRespondPlan?: (promptId: number, approved: boolean, feedback?: string) => void;
}

type FeedItem =
  | { type: 'message'; key: string; at: number; message: BoardMessage }
  | { type: 'prompt'; key: string; at: number; prompt: MasterPrompt };

/**
 * Board entries and master prompts come from different sources with
 * different timestamp formats. SQLite's `datetime('now')` returns a
 * naive string (no timezone) for both the `company_board` and the
 * `company_master_prompts` rows, so we treat them identically: parse as
 * UTC for ordering.
 */
function parseAt(s: string): number {
  // If the string already has a zone (Z/±hh:mm), Date() handles it.
  // Otherwise treat as UTC (matches SQLite datetime('now')).
  const hasZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(s);
  return new Date(hasZone ? s : s + 'Z').getTime();
}

export const BoardPanel = memo(function BoardPanel({
  messages,
  masterPrompts = [],
  onAnswerQuestion,
  onRespondPlan,
}: BoardPanelProps) {
  const { t } = useTranslation('agents');
  const bottomRef = useRef<HTMLDivElement>(null);

  const items: FeedItem[] = [
    ...messages.map<FeedItem>((m) => ({
      type: 'message', key: `m-${m.id}`, at: parseAt(m.created_at), message: m,
    })),
    ...masterPrompts.map<FeedItem>((p) => ({
      type: 'prompt', key: `p-${p.id}`, at: parseAt(p.created_at), prompt: p,
    })),
  ].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    // Tie-break: messages before prompts so a synthesised "human answered"
    // decision posted in the same second appears after the prompt card.
    return a.type === 'message' ? -1 : 1;
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items.length]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('board.title')}</span>
        <Badge variant="outline" className="text-[10px]">{items.length}</Badge>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {items.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">{t('board.noActivity')}</p>
        )}
        {items.map((item) => {
          if (item.type === 'prompt') {
            return (
              <MasterPromptCard
                key={item.key}
                prompt={item.prompt}
                onAnswerQuestion={(answer) => onAnswerQuestion?.(item.prompt.id, answer)}
                onRespondPlan={(approved, fb) => onRespondPlan?.(item.prompt.id, approved, fb)}
              />
            );
          }
          const msg = item.message;
          const Icon = KIND_ICONS[msg.kind] ?? MessageSquare;
          return (
            <div key={item.key} className="rounded-lg border p-3 text-xs space-y-1.5 bg-card">
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className={cn('text-[10px] px-1.5', getRoleColor(msg.author_role))}>
                  @{msg.author_role}
                </Badge>
                <Icon className="h-3 w-3 text-muted-foreground" />
                <Badge variant="outline" className="text-[9px] px-1 text-muted-foreground">{msg.kind}</Badge>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-foreground/90 text-xs leading-relaxed">
                <Markdown text={msg.content} />
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
});
