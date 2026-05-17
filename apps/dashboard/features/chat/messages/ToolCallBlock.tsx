import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Loader2, Wrench, X } from 'lucide-react';
import type { ToolCallEvent } from '../../../hooks/useAgentStream.js';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';

interface ToolCallBlockProps {
  call: ToolCallEvent;
}

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
    a.durationMs === b.durationMs
  );
});

function ToolCallBlockInner({ call }: ToolCallBlockProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const isMcp = call.name.startsWith('mcp__');
  const display = isMcp ? call.name.replace(/^mcp__[^_]*__/, '').replace(/^mcp__/, '') : call.name;

  const StatusIcon = call.status === 'running' ? Loader2 : call.status === 'error' ? X : Check;
  const statusColor =
    call.status === 'error'
      ? 'text-destructive bg-destructive/10'
      : call.status === 'running'
        ? 'text-warning bg-warning/10'
        : 'text-success bg-success/10';

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
        {call.durationMs !== undefined && (
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0">{call.durationMs}ms</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t bg-background/50">
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
