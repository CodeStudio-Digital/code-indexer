import { useTranslation } from 'react-i18next';
import { Bot, Check, X } from 'lucide-react';
import type { ParallelAgent } from '../../../hooks/useAgentStream.js';
import { Badge } from '../../../components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from './Markdown.js';

interface AgentDetailModalProps {
  agent: ParallelAgent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Static, after-the-fact detail for a single spawned agent: its task (prompt),
 * final report, and metrics. Subagents are ephemeral (no persisted step-by-step
 * transcript), so this surfaces what survives — the report + task + meta.
 */
export function AgentDetailModal({ agent, open, onOpenChange }: AgentDetailModalProps) {
  const { t } = useTranslation('chat');
  const isError = !!agent.error;
  const tokens = agent.usage ? agent.usage.input_tokens + agent.usage.output_tokens : null;
  const providerLabel =
    agent.provider && agent.model ? `${agent.provider}:${agent.model}` : agent.provider ?? agent.model ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <div
              className={cn(
                'h-5 w-5 rounded-md flex items-center justify-center shrink-0',
                isError ? 'text-destructive bg-destructive/10' : 'text-success bg-success/10',
              )}
            >
              {isError ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
            </div>
            <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-mono truncate">{agent.label}</span>
          </DialogTitle>
        </DialogHeader>

        {/* Meta badges */}
        <div className="flex flex-wrap items-center gap-1.5 -mt-1">
          {agent.agentType && <Badge variant="outline" className="text-[10px]">{agent.agentType}</Badge>}
          {providerLabel && (
            <Badge variant="secondary" className="text-[10px] max-w-[240px] truncate" title={providerLabel}>
              {providerLabel}
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px] tabular-nums">
            {agent.toolCallCount} tool{agent.toolCallCount !== 1 ? 's' : ''}
          </Badge>
          {tokens !== null && (
            <Badge variant="outline" className="text-[10px] tabular-nums">{tokens.toLocaleString()} tokens</Badge>
          )}
        </div>

        {/* Task (the prompt the agent received) */}
        {agent.task && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              {t('agentGroup.task', { defaultValue: 'Task' })}
            </div>
            <div className="text-xs text-foreground/80 whitespace-pre-wrap rounded-md border bg-muted/30 p-2 max-h-48 overflow-y-auto">
              {agent.task}
            </div>
          </div>
        )}

        {/* Report / error */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            {isError
              ? t('agentGroup.error', { defaultValue: 'Error' })
              : t('agentGroup.report', { defaultValue: 'Report' })}
          </div>
          {isError ? (
            <pre className="font-mono text-[11px] text-destructive whitespace-pre-wrap break-all rounded-md border border-destructive/40 p-2">
              {agent.error}
            </pre>
          ) : agent.summary ? (
            <div className="text-sm text-foreground/90">
              <Markdown text={agent.summary} />
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic">
              {t('agentGroup.noReport', { defaultValue: 'No report produced.' })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
