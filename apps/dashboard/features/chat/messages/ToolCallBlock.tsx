import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Loader2, ShieldQuestion, Wrench, X } from 'lucide-react';
import type { ToolCallEvent } from '../../../hooks/useAgentStream.js';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import { ToolApprovalCard, type ToolApprovalVerdict } from './ToolApprovalCard.js';

interface ToolCallBlockProps {
  call: ToolCallEvent;
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
    a.progressNote === b.progressNote &&
    // Approval requests attach/detach mid-flight (PermissionGate pauses).
    a.approvals === b.approvals
  );
});

function ToolCallBlockInner({ call, onToolApproval, children }: ToolCallBlockProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const isMcp = call.name.startsWith('mcp__');
  const display = isMcp ? call.name.replace(/^mcp__[^_]*__/, '').replace(/^mcp__/, '') : call.name;

  // Local 1-second tick while the tool is running, so "running Xs" advances
  // smoothly between the 5s server-side heartbeats. Disabled (and cleaned up)
  // as soon as the tool finishes — an idle session pays nothing. Intentionally
  // NOT ticking while awaiting approval: the user's decision time is not the
  // tool's runtime.
  const isRunning = call.status === 'running';
  const isAwaitingApproval = call.status === 'awaiting_approval';
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning || !call.startedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning, call.startedAt]);

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
      ? 'text-destructive bg-destructive/10'
      : call.status === 'running' || call.status === 'awaiting_approval'
        ? 'text-warning bg-warning/10'
        : 'text-success bg-success/10';

  // Elapsed seconds derived client-side from `startedAt` (when the
  // tool_call_start event arrived). Falls back to `elapsedMs` from a
  // server heartbeat if the start timestamp is missing (e.g. legacy event
  // before the dashboard upgrade). Only meaningful while running.
  const elapsedSec = isRunning
    ? call.startedAt
      ? Math.floor((Date.now() - call.startedAt) / 1000)
      : call.elapsedMs !== undefined
        ? Math.floor(call.elapsedMs / 1000)
        : null
    : null;

  return (
    <div className="my-2 rounded-lg border bg-muted/30 overflow-hidden text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-muted/60 transition-colors"
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0', open && 'rotate-90')}
        />
        <div className={cn('h-5 w-5 rounded-md flex items-center justify-center shrink-0', statusColor)}>
          <StatusIcon className={cn('h-3 w-3', call.status === 'running' && 'animate-spin')} />
        </div>
        <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="font-mono font-medium text-foreground truncate">{display}</span>
        {isMcp && (
          <Badge variant="info" className="shrink-0">
            mcp
          </Badge>
        )}
        {isAwaitingApproval ? (
          <span className="ml-auto text-warning shrink-0">
            {t('approval.waiting', { defaultValue: 'aguardando aprovação' })}
          </span>
        ) : call.durationMs !== undefined ? (
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0">{call.durationMs}ms</span>
        ) : elapsedSec !== null ? (
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0">
            running {elapsedSec}s
          </span>
        ) : null}
      </button>
      {/* PermissionGate card — pinned OUTSIDE the collapse so the user can
          act without expanding the block. */}
      {onToolApproval && call.approvals && call.approvals.length > 0 && (
        <div className="px-3 pb-3 pt-1 border-t bg-background/50">
          <ToolApprovalCard approvals={call.approvals} onRespond={onToolApproval} />
        </div>
      )}
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t bg-background/50">
          {isRunning && call.progressNote && (
            <div className="mt-2 rounded-md border border-warning/30 bg-warning/[0.06] px-2 py-1.5 font-mono text-[11px] text-warning-foreground">
              {call.progressNote}
            </div>
          )}
          {/* Rich detail slot — replaces the raw input/result dump when provided. */}
          {children ? (
            <div className="mt-1">{children}</div>
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
          {call.result && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                {call.result.isError ? t('messages.toolResultError') : t('messages.toolResult')}
              </div>
              <pre
                className={cn(
                  'font-mono text-[11px] bg-card border rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-96 overflow-y-auto',
                  call.result.isError && 'border-destructive/40 text-destructive',
                )}
              >
                {call.result.content}
              </pre>
              {call.result.image && (
                <img
                  src={`data:${call.result.image.mediaType};base64,${call.result.image.base64}`}
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
