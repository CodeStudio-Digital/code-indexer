import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, Info, PanelLeft } from 'lucide-react';
import type { ContextStatus, IndexStatus, RunDelta, Usage } from '../../hooks/useAgentStream.js';
import { Badge } from '../../components/ui/badge.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn } from '../../lib/utils.js';
import { providerAccent, providerLabel } from './constants.js';
import type { CoderSession, CoderSessionStats } from './types.js';
import { formatDuration } from './utils.js';

/** Format token counts in a compact human-readable form (e.g. 180k, 1.2M). */
function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

interface ChatHeaderProps {
  session: CoderSession;
  streaming: boolean;
  runDelta: RunDelta;
  lastUsage: Usage | null;
  stats: CoderSessionStats | null;
  contextStatus: ContextStatus | null;
  indexStatus: IndexStatus | null;
  onOpenDetails: () => void;
  onOpenSidebar?: () => void;
  onOpenToolConfig?: () => void;
  onOpenSkillConfig?: () => void;
  onOpenMetrics?: () => void;
  onOpenSnapshots?: () => void;
  /** Open the Tool Stats modal (aggregated coder_tool_calls breakdown).
   *  Diagnostic helper added alongside the loop-detection banners. */
  onOpenToolStats?: () => void;
  /** Pending file-snapshot count to badge on the Snapshots button. 0 hides the badge. */
  pendingSnapshots?: number;
  /** Whether the right-side Meta sidebar is currently open. */
  metaSidebarOpen?: boolean;
  /** Toggle the Meta sidebar (goal/tasks/skills/services). Hides the button if undefined. */
  onToggleMetaSidebar?: () => void;
  /** Whether the side-by-side Worker Log panel is open. */
  workerLogOpen?: boolean;
  /** Toggle the Worker Log panel. Hides the button if undefined. */
  onToggleWorkerLog?: () => void;
}

export function ChatHeader({ session, streaming, runDelta, lastUsage, stats, contextStatus, indexStatus, onOpenDetails, onOpenSidebar, onOpenToolConfig, onOpenSkillConfig, onOpenMetrics, onOpenSnapshots, onOpenToolStats, pendingSnapshots, metaSidebarOpen, onToggleMetaSidebar, workerLogOpen, onToggleWorkerLog }: ChatHeaderProps) {
  const { t } = useTranslation(['chat', 'common']);
  // Persisted (from DB) + runtime delta (current run, if streaming).
  const totalIn = session.total_input_tokens;
  const totalOut = session.total_output_tokens;

  // Context window usage: prefer live SSE data, fall back to persisted stats.
  const lastTurnInput = lastUsage?.input_tokens ?? session.last_turn_input_tokens ?? 0;
  const contextWindow = contextStatus?.context_window ?? stats?.context_window ?? null;
  const ctxPct = contextWindow && lastTurnInput > 0
    ? Math.min(Math.round((lastTurnInput / contextWindow) * 100), 100)
    : null;

  return (
    // `min-w-0` lets the flex children shrink past their intrinsic width
    // when the chat column is narrow (right rail open + small viewport),
    // preventing the row from wrapping into two lines (which is what
    // produced the "tokens widget on top of avatar" stack reported in
    // the bug screenshot).
    <div className="border-b px-3 sm:px-5 py-3 flex items-center gap-2 sm:gap-3 bg-card/80 backdrop-blur min-w-0 shrink-0">
      {onOpenSidebar && (
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={t('chat:openSessions')}
          className="lg:hidden p-1.5 -ml-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      )}
      <div
        className={cn(
          'h-9 w-9 rounded-lg flex items-center justify-center text-white shrink-0',
          providerAccent(session.provider),
        )}
      >
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm truncate">{session.title}</div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Badge variant="muted" className="h-4">
            {providerLabel(session.provider)}
          </Badge>
          <span className="font-mono">{session.model}</span>
          {indexStatus && !indexStatus.mcpAvailable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="h-4 gap-1 text-amber-500 border-amber-500/30 cursor-help">
                  <AlertTriangle className="h-3 w-3" />
                  {t('common:status.notIndexed')}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {t('chat:header.notIndexedTooltip')}
              </TooltipContent>
            </Tooltip>
          )}
          {streaming && (
            <span className="ml-1 inline-flex items-center gap-1 text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              {t('common:status.streaming')}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="hidden xl:flex flex-col items-end gap-0.5 tabular-nums cursor-help">
              {ctxPct !== null && contextWindow ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          ctxPct > 90 ? 'bg-red-500' : ctxPct > 70 ? 'bg-amber-500' : 'bg-emerald-500',
                        )}
                        style={{ width: `${ctxPct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-foreground font-medium">{ctxPct}%</span>
                  </div>
                  <div className="text-[10px]">
                    {formatK(lastTurnInput)} / {formatK(contextWindow)}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[10px]">
                    ↑ <span className="text-foreground font-medium">{formatK(totalIn)}</span>
                  </div>
                  <div className="text-[10px]">
                    ↓ <span className="text-foreground font-medium">{formatK(totalOut)}</span>
                  </div>
                </>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <StatsTooltip session={session} lastUsage={lastUsage} stats={stats} contextWindow={contextWindow} lastTurnInput={lastTurnInput} ctxPct={ctxPct} />
          </TooltipContent>
        </Tooltip>
        {/* Session-details is still on the header as a fallback affordance —
            the activity rail also has a Details panel, but power users still
            expect a clickable "i" in the title bar. The other tool toggles
            (Skills/Tools/Metrics/ToolStats/WorkerLog/Meta/Snapshots) moved
            to the right activity rail. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('chat:header.sessionDetails')}
              onClick={onOpenDetails}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <Info className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('chat:header.sessionDetails')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function StatsTooltip({
  session,
  lastUsage,
  stats,
  contextWindow,
  lastTurnInput,
  ctxPct,
}: {
  session: CoderSession;
  lastUsage: Usage | null;
  stats: CoderSessionStats | null;
  contextWindow: number | null;
  lastTurnInput: number;
  ctxPct: number | null;
}) {
  const totalIn = session.total_input_tokens;
  const totalOut = session.total_output_tokens;
  const totalCR = session.total_cache_read_tokens ?? 0;
  const totalCW = session.total_cache_creation_tokens ?? 0;
  const hitRate = totalIn > 0 ? Math.round((totalCR / totalIn) * 100) : 0;
  const savedTokens = Math.round(totalCR * 0.5);
  const { t } = useTranslation('chat');
  return (
    <div className="space-y-1.5 text-xs">
      {/* Context Window section */}
      {ctxPct !== null && contextWindow && (
        <>
          <div className="font-semibold">{t('header.contextWindow')}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
            <span>{t('header.currentContext')}</span>
            <span className="text-right">{lastTurnInput.toLocaleString()}</span>
            <span>{t('header.windowSize')}</span>
            <span className="text-right">{contextWindow.toLocaleString()}</span>
            <span>{t('header.contextUsage')}</span>
            <span className={cn('text-right font-medium', ctxPct > 90 ? 'text-red-400' : ctxPct > 70 ? 'text-amber-400' : 'text-emerald-400')}>
              {ctxPct}%
            </span>
          </div>
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                ctxPct > 90 ? 'bg-red-500' : ctxPct > 70 ? 'bg-amber-500' : 'bg-emerald-500',
              )}
              style={{ width: `${ctxPct}%` }}
            />
          </div>
        </>
      )}

      {/* API Totals (billing) section */}
      <div className={cn('font-semibold', ctxPct !== null && 'mt-1 pt-1 border-t border-border/40')}>
        {t('header.apiTotals')}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
        <span>{t('header.totalInput')}</span>
        <span className="text-right">{totalIn.toLocaleString()}</span>
        <span>{t('header.output')}</span>
        <span className="text-right">{totalOut.toLocaleString()}</span>
        <span>{t('header.cacheRead')}</span>
        <span className="text-right text-emerald-300">{totalCR.toLocaleString()}</span>
        <span>{t('header.cacheWrite')}</span>
        <span className="text-right">{totalCW.toLocaleString()}</span>
        <span>{t('header.hitRate')}</span>
        <span className="text-right text-emerald-300">{hitRate}%</span>
        <span>{t('header.tokensSaved')}</span>
        <span className="text-right text-emerald-300">{savedTokens.toLocaleString()}</span>
      </div>

      {/* Last turn */}
      {lastUsage && (
        <div className="mt-1 pt-1 border-t border-border/40 text-emerald-300">
          {t('header.lastTurn', {
            context: lastUsage.input_tokens.toLocaleString(),
            output: lastUsage.output_tokens.toLocaleString(),
            cache: (lastUsage.cache_read_input_tokens ?? 0).toLocaleString(),
          })}
        </div>
      )}

      {/* Activity */}
      {stats && (
        <div className="mt-1 pt-1 border-t border-border/40 grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
          <span>{t('header.messages')}</span>
          <span className="text-right">{stats.message_count}</span>
          <span>{t('header.assistantTurns')}</span>
          <span className="text-right">{stats.assistant_turns}</span>
          <span>{t('header.toolCalls')}</span>
          <span className="text-right">{stats.tool_call_count}</span>
          <span>{t('header.distinctTools')}</span>
          <span className="text-right">{stats.distinct_tools}</span>
          {stats.tool_error_count > 0 && (
            <>
              <span>{t('header.toolErrors')}</span>
              <span className="text-right text-red-300">{stats.tool_error_count}</span>
            </>
          )}
          {stats.subagent_call_count > 0 && (
            <>
              <span>{t('header.subagents')}</span>
              <span className="text-right">{stats.subagent_call_count}</span>
            </>
          )}
          <span>{t('header.timeInTools')}</span>
          <span className="text-right">{(stats.total_tool_duration_ms / 1000).toFixed(1)}s</span>
          <span>{t('header.duration')}</span>
          <span className="text-right">{formatDuration(stats.duration_ms)}</span>
        </div>
      )}
    </div>
  );
}
