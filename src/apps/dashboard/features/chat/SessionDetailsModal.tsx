import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BarChart3, Check, ChevronDown, ChevronRight, Circle, ClipboardList, Copy, ListChecks, Loader2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { useApi } from '../../hooks/useApi.js';
import { cn, formatRelativeTime } from '../../lib/utils.js';
import { formatDuration } from './utils.js';

interface CoderPlanRow {
  id: number;
  session_id: number;
  tool_use_id: string;
  message_id: number | null;
  plan_text: string;
  status: 'pending' | 'approved' | 'rejected' | 'aborted';
  feedback: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface TodoHistoryEntry {
  id: number;
  args_json: string;
  created_at: string;
}

interface TodoItem {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface SessionStatsLike {
  message_count: number;
  assistant_turns: number;
  tool_call_count: number;
  tool_error_count: number;
  distinct_tools: number;
  subagent_call_count: number;
  total_tool_duration_ms: number;
  duration_ms: number;
  last_turn_input_tokens?: number;
  context_window?: number | null;
}

interface SessionLike {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens?: number;
  total_cache_creation_tokens?: number;
  last_turn_input_tokens?: number;
}

interface SessionDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number | null;
  session: SessionLike | null;
  stats: SessionStatsLike | null;
}

const STATUS_STYLES: Record<CoderPlanRow['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  approved: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  rejected: 'bg-red-500/15 text-red-600 dark:text-red-400',
  aborted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

// STATUS_LABELS is now provided via i18n t('details.planStatus.*')

export function SessionDetailsModal({
  open,
  onOpenChange,
  sessionId,
  session,
  stats,
}: SessionDetailsModalProps) {
  const { t } = useTranslation(['chat', 'common']);
  const plansUrl = open && sessionId ? `/coder/sessions/${sessionId}/plans` : '';
  const { data: plans, loading } = useApi<CoderPlanRow[]>(plansUrl);
  const todoHistoryUrl = open && sessionId ? `/coder/sessions/${sessionId}/todo-history` : '';
  const { data: todoHistory, loading: todoHistoryLoading } = useApi<TodoHistoryEntry[]>(todoHistoryUrl);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('chat:details.title')}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="summary" className="flex-1 flex flex-col min-h-0">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="summary" className="gap-1.5">
              <BarChart3 className="h-3.5 w-3.5" /> {t('chat:details.summary')}
            </TabsTrigger>
            <TabsTrigger value="plans" className="gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" /> {t('chat:details.plans')}
              {plans && plans.length > 0 && (
                <Badge variant="muted" className="h-4 text-[10px] ml-1">
                  {plans.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="todos" className="gap-1.5">
              <ListChecks className="h-3.5 w-3.5" /> {t('chat:details.tasks')}
              {todoHistory && todoHistory.length > 0 && (
                <Badge variant="muted" className="h-4 text-[10px] ml-1">
                  {todoHistory.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="flex-1 overflow-y-auto mt-4">
            {session ? (
              <SummaryTab session={session} stats={stats} />
            ) : (
              <div className="text-xs text-muted-foreground">{t('chat:details.noData')}</div>
            )}
          </TabsContent>

          <TabsContent value="plans" className="flex-1 overflow-y-auto mt-4">
            {loading && <div className="text-xs text-muted-foreground">{t('common:actions.loading')}</div>}
            {!loading && (!plans || plans.length === 0) && (
              <div className="text-xs text-muted-foreground py-8 text-center">
                {t('chat:details.noPlans')}
              </div>
            )}
            <div className="space-y-2">{plans?.map((p) => <PlanItem key={p.id} plan={p} />)}</div>
          </TabsContent>

          <TabsContent value="todos" className="flex-1 overflow-y-auto mt-4">
            {todoHistoryLoading && <div className="text-xs text-muted-foreground">{t('common:actions.loading')}</div>}
            {!todoHistoryLoading && (!todoHistory || todoHistory.length === 0) && (
              <div className="text-xs text-muted-foreground py-8 text-center">
                {t('chat:details.noTasks')}
              </div>
            )}
            <div className="space-y-2">
              {todoHistory?.map((entry) => <TodoHistoryItem key={entry.id} entry={entry} />)}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Format token counts compactly (e.g. 180k, 1.2M). */
function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function SummaryTab({ session, stats }: { session: SessionLike; stats: SessionStatsLike | null }) {
  const { t } = useTranslation('chat');
  const totalIn = session.total_input_tokens;
  const totalOut = session.total_output_tokens;
  const totalCR = session.total_cache_read_tokens ?? 0;
  const totalCW = session.total_cache_creation_tokens ?? 0;
  const hitRate = totalIn > 0 ? Math.round((totalCR / totalIn) * 100) : 0;
  const savedTokens = Math.round(totalCR * 0.5);

  const lastTurnInput = session.last_turn_input_tokens ?? stats?.last_turn_input_tokens ?? 0;
  const contextWindow = stats?.context_window ?? null;
  const ctxPct = contextWindow && lastTurnInput > 0
    ? Math.min(Math.round((lastTurnInput / contextWindow) * 100), 100)
    : null;

  return (
    <div className="space-y-4 text-sm">
      {/* Context Window section */}
      {ctxPct !== null && contextWindow && (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {t('header.contextWindow')}
          </h4>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 tabular-nums">
            <span className="text-muted-foreground">{t('header.currentContext')}</span>
            <span className="text-right">{lastTurnInput.toLocaleString()} ({formatK(lastTurnInput)})</span>
            <span className="text-muted-foreground">{t('header.windowSize')}</span>
            <span className="text-right">{contextWindow.toLocaleString()} ({formatK(contextWindow)})</span>
            <span className="text-muted-foreground">{t('header.contextUsage')}</span>
            <span className={cn('text-right font-medium', ctxPct > 90 ? 'text-red-500' : ctxPct > 70 ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-400')}>
              {ctxPct}%
            </span>
          </div>
          <div className="mt-2 w-full h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                ctxPct > 90 ? 'bg-red-500' : ctxPct > 70 ? 'bg-amber-500' : 'bg-emerald-500',
              )}
              style={{ width: `${ctxPct}%` }}
            />
          </div>
        </section>
      )}

      {/* API Totals (billing) */}
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          {t('header.apiTotals')}
        </h4>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 tabular-nums">
          <span className="text-muted-foreground">{t('header.totalInput')}</span>
          <span className="text-right">{totalIn.toLocaleString()}</span>
          <span className="text-muted-foreground">{t('header.output')}</span>
          <span className="text-right">{totalOut.toLocaleString()}</span>
          <span className="text-muted-foreground">{t('header.cacheRead')}</span>
          <span className="text-right text-emerald-600 dark:text-emerald-400">{totalCR.toLocaleString()}</span>
          <span className="text-muted-foreground">{t('header.cacheWrite')}</span>
          <span className="text-right">{totalCW.toLocaleString()}</span>
          <span className="text-muted-foreground">{t('header.hitRate')}</span>
          <span className="text-right text-emerald-600 dark:text-emerald-400">{hitRate}%</span>
          <span className="text-muted-foreground">{t('header.tokensSaved')}</span>
          <span className="text-right text-emerald-600 dark:text-emerald-400">{savedTokens.toLocaleString()}</span>
        </div>
      </section>

      {stats && (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Atividade</h4>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 tabular-nums">
            <span className="text-muted-foreground">{t('header.messages')}</span>
            <span className="text-right">{stats.message_count}</span>
            <span className="text-muted-foreground">{t('header.assistantTurns')}</span>
            <span className="text-right">{stats.assistant_turns}</span>
            <span className="text-muted-foreground">{t('header.toolCalls')}</span>
            <span className="text-right">{stats.tool_call_count}</span>
            <span className="text-muted-foreground">{t('header.distinctTools')}</span>
            <span className="text-right">{stats.distinct_tools}</span>
            {stats.tool_error_count > 0 && (
              <>
                <span className="text-muted-foreground">{t('header.toolErrors')}</span>
                <span className="text-right text-red-500">{stats.tool_error_count}</span>
              </>
            )}
            {stats.subagent_call_count > 0 && (
              <>
                <span className="text-muted-foreground">{t('header.subagents')}</span>
                <span className="text-right">{stats.subagent_call_count}</span>
              </>
            )}
            <span className="text-muted-foreground">{t('header.timeInTools')}</span>
            <span className="text-right">{(stats.total_tool_duration_ms / 1000).toFixed(1)}s</span>
            <span className="text-muted-foreground">{t('header.duration')}</span>
            <span className="text-right">{formatDuration(stats.duration_ms)}</span>
          </div>
        </section>
      )}
    </div>
  );
}

function PlanItem({ plan }: { plan: CoderPlanRow }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(plan.plan_text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const preview = plan.plan_text.split('\n').find((l) => l.trim()) ?? '';

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className={cn('text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded', STATUS_STYLES[plan.status])}
            >
              {t(`details.planStatus.${plan.status}`)}
            </span>
            <span className="text-[11px] text-muted-foreground">{formatRelativeTime(plan.created_at)}</span>
            {plan.resolved_at && plan.resolved_at !== plan.created_at && (
              <span className="text-[11px] text-muted-foreground">
                · {t('details.resolvedAt', { time: formatRelativeTime(plan.resolved_at) })}
              </span>
            )}
          </div>
          {!open && <div className="text-xs text-foreground/80 truncate">{preview}</div>}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t bg-muted/20">
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 hover:bg-muted"
              aria-label="Copy plan markdown"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? t('details.copiedPlan') : t('details.copyPlan')}
            </button>
          </div>
          <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-card prose-pre:border prose-pre:rounded-lg prose-pre:p-3 prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.plan_text}</ReactMarkdown>
          </div>
          {plan.feedback && (
            <div className="mt-2 text-xs border-l-2 border-amber-500/50 pl-2 text-muted-foreground">
              <span className="font-semibold">{t('details.feedback')}</span> {plan.feedback}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TodoHistoryItem({ entry }: { entry: TodoHistoryEntry }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);

  let todos: TodoItem[] = [];
  try {
    const parsed = JSON.parse(entry.args_json);
    if (Array.isArray(parsed.todos)) todos = parsed.todos;
  } catch {
    /* invalid json — leave empty */
  }

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const preview =
    todos.find((t) => t.status === 'in_progress')?.activeForm ??
    todos.find((t) => t.status === 'pending')?.content ??
    todos[todos.length - 1]?.content ??
    '';

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {t('details.tasksCompleted', { completed, total })}
            </span>
            <span className="text-[11px] text-muted-foreground">{formatRelativeTime(entry.created_at)}</span>
          </div>
          {!open && total > 0 && <div className="text-xs text-foreground/80 truncate">{preview}</div>}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t bg-muted/20">
          <ul className="pt-2 space-y-1">
            {todos.map((t, i) => (
              <li
                key={`${i}-${t.content}`}
                className="flex items-start gap-2 text-xs px-1.5 py-1"
              >
                <span className="mt-0.5 shrink-0">
                  {t.status === 'completed' ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : t.status === 'in_progress' ? (
                    <Loader2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 animate-spin" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </span>
                <span
                  className={
                    t.status === 'completed'
                      ? 'text-muted-foreground line-through'
                      : t.status === 'in_progress'
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground'
                  }
                >
                  {t.status === 'in_progress' ? t.activeForm : t.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
