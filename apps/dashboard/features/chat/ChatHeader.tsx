import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, Boxes, Info, Loader2, PanelLeft, Scissors, Star, Workflow } from 'lucide-react';
import type { ContextStatus, IndexStatus, RunDelta, Usage } from '../../hooks/useAgentStream.js';
import { Badge } from '../../components/ui/badge.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn } from '../../lib/utils.js';
import { providerAccent, providerLabel, projectColor, workspaceColor } from './constants.js';
import type { CoderSession, CoderSessionStats, LinkedProject } from './types.js';
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
  /** Trigger the manual "summarize & clear" action. Hides the button if undefined. */
  onSummarizeClear?: () => void;
  /** True while the summary is being generated — shows a spinner + disables the button. */
  summarizing?: boolean;
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
  /** Show the builder-style draw.io canvas toggle (diagram sessions). */
  showCanvasToggle?: boolean;
  /** Whether the diagram canvas panel is currently open. */
  canvasActive?: boolean;
  /** Toggle the diagram canvas. Works even where the 40px activity rail is hidden. */
  onToggleCanvas?: () => void;
  /** Whether the right-side Meta sidebar is currently open. */
  metaSidebarOpen?: boolean;
  /** Toggle the Meta sidebar (goal/tasks/skills/services). Hides the button if undefined. */
  onToggleMetaSidebar?: () => void;
  /** Whether the side-by-side Worker Log panel is open. */
  workerLogOpen?: boolean;
  /** Toggle the Worker Log panel. Hides the button if undefined. */
  onToggleWorkerLog?: () => void;
  /** Global sessions only: count of linked projects in the virtual workspace.
   *  Used as the fallback "N projects" chip when `linkedProjects` is absent. */
  linkedCount?: number;
  /** Open the "manage workspace projects" dialog (attach/remove). Global only. */
  onManageProjects?: () => void;
  /** Global sessions only: the linked projects, rendered as colored chips that
   *  focus the file tree on a single project. */
  linkedProjects?: LinkedProject[];
  /** The synthetic union project id — the "All" chip focuses back on it. */
  workspaceProjectId?: number;
  /** Which project the file tree is currently rooted at (synthetic id = all). */
  activeProjectId?: number | null;
  /** Root the file tree at a project (or the synthetic union for "All"). */
  onFocusProject?: (projectId: number) => void;
}

export const ChatHeader = memo(function ChatHeader({ session, streaming, runDelta, lastUsage, stats, contextStatus, indexStatus, onOpenDetails, onSummarizeClear, summarizing, onOpenSidebar, onOpenToolConfig, onOpenSkillConfig, onOpenMetrics, onOpenSnapshots, onOpenToolStats, pendingSnapshots, metaSidebarOpen, onToggleMetaSidebar, workerLogOpen, onToggleWorkerLog, showCanvasToggle, canvasActive, onToggleCanvas, linkedCount, onManageProjects, linkedProjects, workspaceProjectId, activeProjectId, onFocusProject }: ChatHeaderProps) {
  const { t } = useTranslation(['chat', 'common']);
  // Global session: the workspace accent ties this conversation to its sidebar
  // group. `isGlobal` is implied by having a manage handler + linked count.
  const isGlobal = linkedCount != null && !!onManageProjects;
  const wsAccent = isGlobal ? workspaceColor(workspaceProjectId ?? session.project_id) : null;
  const hasChips = isGlobal && !!linkedProjects && linkedProjects.length > 0 && !!onFocusProject;
  // "All" = the file tree is rooted at the synthetic union (or unset).
  const allActive = activeProjectId == null || activeProjectId === (workspaceProjectId ?? session.project_id);
  // Persisted (from DB) + runtime delta (current run, if streaming).
  const totalIn = session.total_input_tokens;
  const totalOut = session.total_output_tokens;

  // Context window usage — SINGLE source of truth. Live: the `context_status`
  // event (the same cache-inclusive number the runner's compaction gates act
  // on). At rest: the persisted cache-inclusive prompt of the last turn from
  // stats, falling back to the legacy cache-blind column for old sessions.
  // `lastUsage.input_tokens` no longer feeds this bar — mixing it with the
  // persisted value is what made the gauge jump on send (70k → 100k).
  const lastTurnInput =
    contextStatus?.prompt_tokens ??
    stats?.last_turn_prompt_tokens ??
    session.last_turn_input_tokens ??
    0;
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
    <div className="border-b border-[var(--workbench-border)] px-3 sm:px-5 py-3 flex items-center gap-2 sm:gap-3 bg-[var(--workbench-raised)] min-w-0 shrink-0">
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
        style={wsAccent ? { boxShadow: `0 0 0 2px ${wsAccent.solid}` } : undefined}
      >
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm truncate">{session.title}</div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Badge variant="muted" className="h-4">
            {providerLabel(session.provider)}
          </Badge>
          {session.import_source && (
            <Badge variant="outline" className="h-4 border-primary/30 text-primary" title={t('chat:sessionImport.importedBadge')}>
              {session.import_source === 'claude-code' ? 'Claude Code' : 'Codex'}
            </Badge>
          )}
          <span className="font-mono">{session.model}</span>
          {/* Generic "N projects" chip — only when we can't render the richer
              per-project colored chips (no linked-projects payload yet). */}
          {linkedCount != null && onManageProjects && !hasChips && (
            <button
              type="button"
              onClick={onManageProjects}
              title={t('chat:global.manageTitle')}
              className="inline-flex items-center gap-1 rounded border px-1.5 h-4 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <Boxes className="h-3 w-3" />
              {t('chat:global.projectsChip', { count: linkedCount })}
            </button>
          )}
          {indexStatus && !indexStatus.mcpAvailable && (
            <Badge
              variant="outline"
              title={t('chat:header.notIndexedTooltip')}
              className="h-4 gap-1 text-amber-500 border-amber-500/30 cursor-help"
            >
              <AlertTriangle className="h-3 w-3" />
              {t('common:status.notIndexed')}
            </Badge>
          )}
          {streaming && (
            <span className="ml-1 inline-flex items-center gap-1 text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              {t('common:status.streaming')}
            </span>
          )}
        </div>
        {/* Global session: colored per-project chips. Clicking one roots the
            file tree at that project; "All" returns to the union. Lets the user
            tell — and steer — which project a multi-root conversation touches. */}
        {hasChips && (
          <div className="mt-1 flex items-center gap-1 overflow-x-auto pb-0.5 chat-scroll">
            <button
              type="button"
              onClick={() => onFocusProject!(workspaceProjectId ?? session.project_id)}
              className={cn(
                'shrink-0 rounded border px-1.5 h-5 text-[10px] font-medium transition-colors',
                allActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60',
              )}
              aria-pressed={allActive}
            >
              {t('chat:global.allProjects')}
            </button>
            {linkedProjects!.map((p) => {
              const c = projectColor(p.project_id);
              const active = activeProjectId === p.project_id;
              return (
                <button
                  key={p.project_id}
                  type="button"
                  onClick={() => onFocusProject!(p.project_id)}
                  title={t('chat:global.focusProject', { name: p.name })}
                  aria-pressed={active}
                  className="shrink-0 inline-flex items-center gap-1 rounded border px-1.5 h-5 text-[10px] font-medium transition-colors max-w-[160px]"
                  style={{
                    borderColor: c.solid,
                    backgroundColor: active ? c.soft : 'transparent',
                    color: active ? c.text : undefined,
                  }}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: c.solid }} />
                  <span className="truncate">{p.name}</span>
                  {p.is_primary && <Star className="h-2.5 w-2.5 shrink-0 fill-current" />}
                </button>
              );
            })}
            {onManageProjects && (
              <button
                type="button"
                onClick={onManageProjects}
                title={t('chat:global.manageTitle')}
                aria-label={t('chat:global.manageTitle')}
                className="shrink-0 inline-flex items-center justify-center rounded border h-5 w-5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <Boxes className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
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
        {/* Builder-style draw.io canvas toggle — only for diagram sessions.
            Lives in the header so the live canvas is openable even where the
            40px activity rail is hidden (narrow/split mounts). */}
        {showCanvasToggle && onToggleCanvas && (
          <button
            type="button"
            aria-label={t('chat:header.toggleCanvas')}
            title={t('chat:header.toggleCanvas')}
            aria-pressed={canvasActive}
            onClick={onToggleCanvas}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              canvasActive
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            <Workflow className="h-4 w-4" />
          </button>
        )}
        {/* Manual "summarize & clear" — sits next to the context gauge so the
            user can act on context pressure they just saw. Disabled mid-run
            (the backend also refuses with 409). */}
        {onSummarizeClear && (
          <button
            type="button"
            aria-label={t('chat:header.summarizeClear')}
            title={t('chat:header.summarizeClearTooltip')}
            onClick={onSummarizeClear}
            disabled={streaming || summarizing}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {summarizing
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Scissors className="h-4 w-4" />}
          </button>
        )}
        {/* Session-details is still on the header as a fallback affordance —
            the activity rail also has a Details panel, but power users still
            expect a clickable "i" in the title bar. The other tool toggles
            (Skills/Tools/Metrics/ToolStats/WorkerLog/Meta/Snapshots) moved
            to the right activity rail. */}
        <button
          type="button"
          aria-label={t('chat:header.sessionDetails')}
          title={t('chat:header.sessionDetails')}
          onClick={onOpenDetails}
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <Info className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
});

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
