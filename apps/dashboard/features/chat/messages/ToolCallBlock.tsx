import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Database, Loader2, ShieldQuestion, X } from 'lucide-react';
import type { ToolCallEvent } from '../../../hooks/useAgentStream.js';
import { useNow } from '../../../lib/perf/shared-clock.js';
import { cn } from '../../../lib/utils.js';
import { ToolApprovalCard, type ToolApprovalVerdict } from './ToolApprovalCard.js';
import { DbQueryToolView } from './DbQueryToolView.js';
import { analyzeSqlForDisplay, parseDbQueryInput } from './db-query-view.js';

interface ToolCallBlockProps {
  call: ToolCallEvent;
  /** Session id enables lazy loading of a transport-trimmed persisted result. */
  sessionId?: string;
  /**
   * PermissionGate verdict callback. When set AND `call.approvals` is
   * non-empty, the approval card renders pinned below the header (outside
   * the collapse) so the user can act without expanding the block.
   */
  onToolApproval?: (toolUseId: string, verdict: ToolApprovalVerdict) => Promise<void>;
  /**
   * Optional rich detail rendered in the expanded body INSTEAD of the raw
   * input/result JSON. Used by the chat transcript to show answered
   * interactive tools (submit_plan / ask_user) as their resolved card while
   * keeping the block collapsed-by-default — the same affordance the image
   * tools (view_image / preview_screenshot) use for their preview.
   */
  children?: React.ReactNode;
}

// NOTE: the comparator intentionally ignores `children`. It's only passed for
// historical (resolved) blocks whose data is deterministic, so skipping a
// re-render is correct. Including it would always differ (fresh JSX each
// render) and defeat the memo for every tool block.
export const ToolCallBlock = React.memo(ToolCallBlockInner, (prev, next) => {
  const a = prev.call;
  const b = next.call;
  // Shallow fields that actually affect render; input/result objects are
  // replaced when they change (handlers.ts always creates new wrappers) so
  // reference equality is sufficient.
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.status === b.status &&
    a.input === b.input &&
    a.result === b.result &&
    a.durationMs === b.durationMs &&
    // Live-progress fields — without these the heartbeat-driven re-render
    // would be blocked by the memo and the "running Xs" counter / progress
    // note would never update.
    a.startedAt === b.startedAt &&
    a.elapsedMs === b.elapsedMs &&
    a.idleMs === b.idleMs &&
    a.progressNote === b.progressNote &&
    a.waitingForChildTitle === b.waitingForChildTitle &&
    // Approval requests attach/detach mid-flight (PermissionGate pauses).
    a.approvals === b.approvals
    && prev.sessionId === next.sessionId
  );
});

function ToolCallBlockInner({ call, sessionId, onToolApproval, children }: ToolCallBlockProps) {
  const { t } = useTranslation('chat');
  const isDbQuery = call.name === 'db_query';
  const [open, setOpen] = useState(() => isDbQuery && (call.status === 'running' || call.status === 'awaiting_approval'));
  const isMcp = call.name.startsWith('mcp__');
  const display = isMcp ? call.name.replace(/^mcp__[^_]*__/, '').replace(/^mcp__/, '') : call.name;
  const dbQuery = isDbQuery ? parseDbQueryInput(call.input) : null;
  const dbAnalysis = dbQuery ? analyzeSqlForDisplay(dbQuery.sql) : null;
  const waitingForChild = call.status === 'running' && call.waitingForChildTitle;
  const activityLabel = waitingForChild
    ? t('messages.toolActivity.waitingForChild', { title: waitingForChild })
    : t(toolActivityLabelKey(call.name, call.status), { tool: display });
  const [fullResult, setFullResult] = useState<ToolCallEvent['result']>();
  const [loadingFullResult, setLoadingFullResult] = useState(false);
  const [fullResultError, setFullResultError] = useState<string | null>(null);
  const displayedResult = fullResult ?? call.result;
  const canLoadFullResult = Boolean(
    !fullResult
    && !loadingFullResult
    && call.result?.truncated
    && sessionId
    && call.id,
  );

  useEffect(() => {
    setFullResult(undefined);
    setLoadingFullResult(false);
    setFullResultError(null);
  }, [call.id, sessionId, call.result?.content, call.result?.truncated]);

  const loadFullResult = async () => {
    if (!sessionId || !call.id) return;
    setLoadingFullResult(true);
    setFullResultError(null);
    try {
      const response = await fetch(
        `/api/coder/sessions/${sessionId}/tool-results/${encodeURIComponent(call.id)}/full`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { content?: string; is_error?: boolean };
      setFullResult({ content: data.content ?? '', isError: Boolean(data.is_error) });
    } catch (error) {
      console.warn('[tool-result] failed to load full result', error);
      setFullResultError(t('messages.toolResultFullError'));
    } finally {
      setLoadingFullResult(false);
    }
  };

  // "running Xs" advances between the 5s server-side heartbeats off the
  // app-wide 1 Hz clock instead of a per-block interval — a turn with a dozen
  // concurrent tool calls used to mean a dozen timers and a dozen independent
  // renders per second. Unsubscribed as soon as the tool finishes, so an idle
  // session pays nothing. Intentionally NOT ticking while awaiting approval:
  // the user's decision time is not the tool's runtime.
  const isRunning = call.status === 'running';
  const isAwaitingApproval = call.status === 'awaiting_approval';
  const now = useNow(isRunning && !!call.startedAt);

  const StatusIcon =
    call.status === 'running'
      ? Loader2
      : call.status === 'awaiting_approval'
        ? ShieldQuestion
        : call.status === 'error'
          ? X
          : Check;
  const statusColor =
    call.status === 'error'
      ? 'text-destructive'
      : call.status === 'running' || call.status === 'awaiting_approval'
        ? 'text-warning'
        : 'text-muted-foreground';

  // Elapsed seconds derived client-side from `startedAt` (when the
  // tool_call_start event arrived). Falls back to `elapsedMs` from a
  // server heartbeat if the start timestamp is missing (e.g. legacy event
  // before the dashboard upgrade). Only meaningful while running.
  const elapsedSec = isRunning
    ? call.startedAt
      ? Math.floor((now - call.startedAt) / 1000)
      : call.elapsedMs !== undefined
        ? Math.floor(call.elapsedMs / 1000)
        : null
    : null;
  const noRealOutput = isRunning && !waitingForChild && call.idleMs != null && call.idleMs >= 5_000
    ? t('messages.noRealOutput', { duration: formatShortDuration(call.idleMs) })
    : null;

  return (
    <div className="group/tool mt-1 text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <StatusIcon className={cn('h-3 w-3 shrink-0', statusColor, call.status === 'running' && 'animate-spin')} />
        {isDbQuery
          ? <Database className="h-3 w-3 shrink-0 text-primary" />
          : null}
        <span className="truncate font-medium">{activityLabel}</span>
        <span className="hidden truncate font-mono text-[10px] text-muted-foreground/60 group-hover/tool:inline sm:max-w-52">
          {display}
        </span>
        {dbQuery && dbAnalysis && (
          <>
            <span className="shrink-0 rounded border bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {dbQuery.connection}
            </span>
            <span className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
              dbAnalysis.risk === 'read'
                ? 'bg-success/10 text-success'
                : dbAnalysis.risk === 'destructive'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-warning/10 text-warning',
            )}>
              {t(`dbQuery.risk.${dbAnalysis.risk}`)}
            </span>
            <span
              aria-hidden="true"
              className="hidden min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground sm:inline"
            >
              {dbAnalysis.preview}
            </span>
          </>
        )}
        {isAwaitingApproval ? (
          <span className="ml-auto text-warning shrink-0">
            {t('approval.waiting', { defaultValue: 'aguardando aprovação' })}
          </span>
        ) : call.durationMs !== undefined ? (
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0">{call.durationMs}ms</span>
        ) : elapsedSec !== null ? (
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0" title={noRealOutput ?? undefined}>
            running {elapsedSec}s{noRealOutput ? ` · ${noRealOutput}` : ''}
          </span>
        ) : null}
      </button>
      {/* PermissionGate card — pinned OUTSIDE the collapse so the user can
          act without expanding the block. */}
      {onToolApproval && call.approvals && call.approvals.length > 0 && (
        <div className="ml-4 mt-1 rounded-lg border bg-background/50 px-3 py-2">
          <ToolApprovalCard approvals={call.approvals} onRespond={onToolApproval} />
        </div>
      )}
      {open && !(isDbQuery && call.approvals && call.approvals.length > 0) && (
        <div className="ml-4 mt-1 space-y-2 border-l border-border/60 py-1 pl-3">
          {isRunning && call.progressNote && (
            <div className="mt-2 rounded-md border border-warning/30 bg-warning/[0.06] px-2 py-1.5 font-mono text-[11px] text-warning-foreground">
              {call.progressNote}
            </div>
          )}
          {/* Rich detail slot — replaces the raw input/result dump when provided. */}
          {children ? (
            <div className="mt-1">{children}</div>
          ) : isDbQuery ? (
            <div className="mt-1">
              <DbQueryToolView input={call.input} result={call.result} />
            </div>
          ) : (
            <>
          {call.input !== undefined && call.input !== null && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2 mb-1">{t('messages.toolInput')}</div>
              <pre className="font-mono text-[11px] bg-card border rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {typeof call.input === 'string' ? call.input : JSON.stringify(call.input, null, 2)}
              </pre>
            </div>
          )}
          {displayedResult && (
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {displayedResult.isError ? t('messages.toolResultError') : t('messages.toolResult')}
                </div>
                {call.result?.truncated && !fullResult && (
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>
                      {t('messages.toolResultPreview', {
                        shown: call.result.content.length,
                        total: call.result.originalLength ?? call.result.content.length,
                      })}
                    </span>
                    <button
                      type="button"
                      disabled={!canLoadFullResult}
                      onClick={() => void loadFullResult()}
                      className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loadingFullResult && <Loader2 className="h-3 w-3 animate-spin" />}
                      {loadingFullResult
                        ? t('messages.toolResultLoadingFull')
                        : t('messages.toolResultLoadFull')}
                    </button>
                  </div>
                )}
              </div>
              <pre
                className={cn(
                  'font-mono text-[11px] bg-card border rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-96 overflow-y-auto',
                  displayedResult.isError && 'border-destructive/40 text-destructive',
                )}
              >
                {displayedResult.content}
              </pre>
              {fullResultError && (
                <p className="mt-1 text-[10px] text-destructive">{fullResultError}</p>
              )}
              {displayedResult.image && (
                <img
                  src={`data:${displayedResult.image.mediaType};base64,${displayedResult.image.base64}`}
                  alt={t('messages.toolScreenshotAlt', { defaultValue: 'Tool screenshot' })}
                  className="mt-2 max-w-full rounded-md border"
                />
              )}
            </div>
          )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function toolActivityLabelKey(
  toolName: string,
  status: ToolCallEvent['status'],
): string {
  if (status === 'running') {
    if (isCommandTool(toolName)) return 'messages.toolActivity.runningCommands';
    if (isInspectionTool(toolName)) return 'messages.toolActivity.inspecting';
    return 'messages.toolActivity.running';
  }
  if (status === 'awaiting_approval') return 'messages.toolActivity.awaitingApproval';
  if (status === 'error') return 'messages.toolActivity.failed';
  if (isCommandTool(toolName)) return 'messages.toolActivity.commands';
  if (isInspectionTool(toolName)) return 'messages.toolActivity.inspected';
  if (/^(spawn_|resume_agent|send_message|followup_task)/.test(toolName)) {
    return 'messages.toolActivity.agents';
  }
  return 'messages.toolActivity.completed';
}

function isCommandTool(toolName: string): boolean {
  return /(^|__)(exec_command|shell_command|run_command|code_exec|terminal)$/.test(toolName);
}

function isInspectionTool(toolName: string): boolean {
  return /(^|__)(read_file|view_image|search|search_query|find|glob|grep|rg|list_files|open)$/.test(toolName);
}

function formatShortDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
