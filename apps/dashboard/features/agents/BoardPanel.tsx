import React, { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Zap, HelpCircle, Package, ArrowRightLeft, AlertOctagon, Check, Copy } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { copyText } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { parseDbDate, formatDateTime, formatClock } from '../../lib/datetime.js';
import { Markdown } from '../chat/messages/Markdown.js';
import type { BoardMessage } from '../../hooks/useCompanyStream.js';
import type { MasterPrompt } from '@mcp/company/types.js';
import { MasterPromptCard } from './MasterPromptCard.js';

const KIND_ICONS: Record<string, React.FC<{ className?: string }>> = {
  message: MessageSquare,
  decision: Zap,
  question: HelpCircle,
  deliverable: Package,
  handoff: ArrowRightLeft,
  // Blocker = the agent reported an impediment and its session ended.
  // Visually distinct icon + the row gets red border (see render below).
  blocker: AlertOctagon,
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
  /** Identifies which company session this board belongs to — shown in the header so the user can never confuse boards across sessions. */
  sessionId?: number;
  sessionName?: string;
}

type FeedItem =
  | { type: 'message'; key: string; at: number; message: BoardMessage }
  | { type: 'prompt'; key: string; at: number; prompt: MasterPrompt };

/**
 * Board entries and master prompts come from different sources but share the
 * same SQLite `datetime('now')` shape (naive UTC string, no zone) for both the
 * `company_board` and `company_master_prompts` rows. `parseDbDate` handles the
 * UTC normalization so ordering and display stay in the local timezone.
 */
function parseAt(s: string): number {
  return parseDbDate(s)?.getTime() ?? 0;
}

function formatBoardTime(createdAt: string): string {
  return formatDateTime(createdAt);
}

function buildBoardMarkdown(items: FeedItem[], sessionName?: string, sessionId?: number): string {
  const heading = sessionName
    ? `# ${sessionName}${sessionId !== undefined ? ` (#${sessionId})` : ''}`
    : '# Board';
  const blocks = [heading];

  for (const item of items) {
    if (item.type === 'message') {
      const msg = item.message;
      blocks.push(
        [
          `## @${msg.author_role} - ${msg.kind} - ${formatBoardTime(msg.created_at)}`,
          '',
          msg.content.trim() || '_No content_',
        ].join('\n'),
      );
      continue;
    }

    const prompt = item.prompt;
    const statusLines = [
      `**Status:** ${prompt.status}`,
    ];
    if (prompt.status === 'answered') {
      if (prompt.kind === 'plan') {
        statusLines.push(`**Decision:** ${prompt.approved ? 'approved' : 'rejected'}`);
        if (prompt.feedback) statusLines.push(`**Feedback:** ${prompt.feedback}`);
      } else if (prompt.answer != null) {
        statusLines.push(`**Answer:** ${prompt.answer}`);
      }
    }
    blocks.push(
      [
        `## @master - ${prompt.kind} - ${formatBoardTime(prompt.created_at)}`,
        '',
        ...statusLines,
        '',
        prompt.body.trim() || '_No content_',
      ].join('\n'),
    );
  }

  return `${blocks.join('\n\n').trim()}\n`;
}

export const BoardPanel = memo(function BoardPanel({
  messages,
  masterPrompts = [],
  onAnswerQuestion,
  onRespondPlan,
  sessionId,
  sessionName,
}: BoardPanelProps) {
  const { t } = useTranslation('agents');
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null);

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

  async function handleCopyMarkdown() {
    if (await copyText(buildBoardMarkdown(items, sessionName, sessionId))) {
      setCopiedMarkdown(true);
      setTimeout(() => setCopiedMarkdown(false), 1500);
    }
  }

  async function handleCopyMessageMarkdown(message: BoardMessage) {
    if (await copyText(message.content)) {
      setCopiedMessageId(message.id);
      setTimeout(() => {
        setCopiedMessageId((current) => (current === message.id ? null : current));
      }, 1500);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('board.title')}</span>
        <Badge variant="outline" className="text-[10px]">{items.length}</Badge>
        {sessionName && (
          <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[60%]" title={sessionName}>
            {sessionName}{sessionId !== undefined && ` · #${sessionId}`}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7 shrink-0', !sessionName && 'ml-auto')}
          onClick={handleCopyMarkdown}
          disabled={items.length === 0}
          title={copiedMarkdown ? t('board.copiedMarkdown') : t('board.copyMarkdown')}
          aria-label={copiedMarkdown ? t('board.copiedMarkdown') : t('board.copyMarkdown')}
        >
          {copiedMarkdown ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
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
                onAnswerQuestion={onAnswerQuestion
                  ? (answer) => onAnswerQuestion(item.prompt.id, answer)
                  : undefined}
                onRespondPlan={onRespondPlan
                  ? (approved, fb) => onRespondPlan(item.prompt.id, approved, fb)
                  : undefined}
              />
            );
          }
          const msg = item.message;
          const Icon = KIND_ICONS[msg.kind] ?? MessageSquare;
          const isBlocker = msg.kind === 'blocker';
          return (
            <div
              key={item.key}
              className={cn(
                'rounded-lg border p-3 text-xs space-y-1.5',
                // Blocker stands out — red border + tinted bg so the
                // user can spot the impediment in a long board feed
                // without scrolling text. Matches the "session ended"
                // signal the runner.abort() produces server-side.
                isBlocker
                  ? 'border-destructive/40 bg-destructive/[0.06]'
                  : 'border bg-card',
              )}
            >
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className={cn('text-[10px] px-1.5', getRoleColor(msg.author_role))}>
                  @{msg.author_role}
                </Badge>
                <Icon className={cn('h-3 w-3', isBlocker ? 'text-destructive' : 'text-muted-foreground')} />
                <Badge
                  variant={isBlocker ? 'destructive' : 'outline'}
                  className={cn('text-[9px] px-1', !isBlocker && 'text-muted-foreground')}
                >
                  {isBlocker ? 'BLOCKER' : msg.kind}
                </Badge>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {formatClock(msg.created_at)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 -mr-1 text-muted-foreground hover:text-foreground"
                  onClick={() => handleCopyMessageMarkdown(msg)}
                  title={copiedMessageId === msg.id ? t('board.copiedMessageMarkdown') : t('board.copyMessageMarkdown')}
                  aria-label={copiedMessageId === msg.id ? t('board.copiedMessageMarkdown') : t('board.copyMessageMarkdown')}
                >
                  {copiedMessageId === msg.id ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
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
