import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, Info, PanelLeft, Sparkles, Wrench } from 'lucide-react';
import type { IndexStatus, RunDelta, Usage } from '../../hooks/useAgentStream.js';
import { Badge } from '../../components/ui/badge.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn } from '../../lib/utils.js';
import { providerAccent, providerLabel } from './constants.js';
import type { CoderSession, CoderSessionStats } from './types.js';
import { formatDuration } from './utils.js';

interface ChatHeaderProps {
  session: CoderSession;
  streaming: boolean;
  runDelta: RunDelta;
  lastUsage: Usage | null;
  stats: CoderSessionStats | null;
  indexStatus: IndexStatus | null;
  onOpenDetails: () => void;
  onOpenSidebar?: () => void;
  onOpenToolConfig?: () => void;
  onOpenSkillConfig?: () => void;
}

export function ChatHeader({ session, streaming, runDelta, lastUsage, stats, indexStatus, onOpenDetails, onOpenSidebar, onOpenToolConfig, onOpenSkillConfig }: ChatHeaderProps) {
  const { t } = useTranslation(['chat', 'common']);
  // Persisted (from DB) + runtime delta (current run, if streaming).
  // For active sessions the runDelta is already counted in the DB
  // because bumpUsage runs synchronously per turn — but during the
  // active turn before refetch, it provides immediate feedback.
  const totalIn = session.total_input_tokens;
  const totalOut = session.total_output_tokens;
  const totalCacheRead =
    (session.total_cache_read_tokens ?? 0) + (streaming ? runDelta.cache_read_input_tokens : 0);

  return (
    <div className="border-b px-3 sm:px-5 py-3 flex items-center gap-2 sm:gap-3 bg-card/80 backdrop-blur">
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
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="hidden sm:block text-right tabular-nums cursor-help">
              <div>
                ↑ <span className="text-foreground font-medium">{totalIn.toLocaleString()}</span>
              </div>
              <div>
                ↓ <span className="text-foreground font-medium">{totalOut.toLocaleString()}</span>
              </div>
              {totalCacheRead > 0 && (
                <div className="text-emerald-600 dark:text-emerald-400 mt-0.5">
                  ⚡ {totalCacheRead.toLocaleString()}
                </div>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <StatsTooltip session={session} lastUsage={lastUsage} stats={stats} />
          </TooltipContent>
        </Tooltip>
        {onOpenSkillConfig && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('chat:header.skills')}
                onClick={onOpenSkillConfig}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <Sparkles className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('chat:header.skills')}</TooltipContent>
          </Tooltip>
        )}
        {onOpenToolConfig && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('chat:header.toolConfig')}
                onClick={onOpenToolConfig}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <Wrench className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('chat:header.toolConfig')}</TooltipContent>
          </Tooltip>
        )}
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
}: {
  session: CoderSession;
  lastUsage: Usage | null;
  stats: CoderSessionStats | null;
}) {
  const totalIn = session.total_input_tokens;
  const totalOut = session.total_output_tokens;
  const totalCR = session.total_cache_read_tokens ?? 0;
  const totalCW = session.total_cache_creation_tokens ?? 0;
  const hitRate = totalIn > 0 ? Math.round((totalCR / totalIn) * 100) : 0;
  // Estimated savings: cached tokens are billed at ~50% of standard
  // (per ZAI/GLM and Anthropic docs). So saved ≈ cached × 0.5.
  const savedTokens = Math.round(totalCR * 0.5);
  const { t } = useTranslation('chat');
  return (
    <div className="space-y-1.5 text-xs">
      <div className="font-semibold">{t('header.session')}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
        <span>{t('header.input')}</span>
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
      {lastUsage && (
        <div className="mt-1 pt-1 border-t border-border/40 text-emerald-300">
          {t('header.lastTurn', { input: lastUsage.input_tokens.toLocaleString(), cache: (lastUsage.cache_read_input_tokens ?? 0).toLocaleString() })}
        </div>
      )}
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
