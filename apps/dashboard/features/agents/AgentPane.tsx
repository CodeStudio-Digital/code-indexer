import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, Clock, Loader2, X, Wrench, Crown, Pause, Eye, AlertTriangle, MessageCircle, ListChecks } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import { ActivityLineBlock } from '../../components/stream/ActivityLineBlock.js';
import { AgentActions } from './AgentActions.js';
import type { AgentStreamState } from '../../hooks/useCompanyStream.js';

interface AgentPaneProps {
  agent: AgentStreamState;
  onClick?: () => void;
  /**
   * Per-agent controls (subordinates only — the master uses the
   * session-wide abort). When `onDelete` is provided the action buttons
   * render; `onPause`/`onResume` are additionally status-gated.
   */
  onPause?: () => void;
  onResume?: () => void;
  onDelete?: () => void;
}

const STATUS_CONFIG: Record<string, { icon: React.FC<{ className?: string }>; color: string; labelKey: string; spin?: boolean }> = {
  idle: { icon: Clock, color: 'text-muted-foreground bg-muted/50', labelKey: 'status.idle' },
  running: { icon: Loader2, color: 'text-warning bg-warning/10', labelKey: 'status.running', spin: true },
  working: { icon: Loader2, color: 'text-blue-400 bg-blue-500/10', labelKey: 'status.working', spin: true },
  waiting: { icon: Pause, color: 'text-yellow-400 bg-yellow-500/10', labelKey: 'status.waiting' },
  waiting_plan: { icon: Clock, color: 'text-yellow-400 bg-yellow-500/10', labelKey: 'status.planReview' },
  waiting_question: { icon: MessageCircle, color: 'text-purple-400 bg-purple-500/10', labelKey: 'status.question' },
  waiting_tasks: { icon: ListChecks, color: 'text-yellow-400 bg-yellow-500/10', labelKey: 'status.tasksReview' },
  reviewing: { icon: Eye, color: 'text-cyan-400 bg-cyan-500/10', labelKey: 'status.reviewing' },
  blocked: { icon: AlertTriangle, color: 'text-orange-400 bg-orange-500/10', labelKey: 'status.blocked' },
  completed: { icon: Check, color: 'text-success bg-success/10', labelKey: 'status.done' },
  error: { icon: X, color: 'text-destructive bg-destructive/10', labelKey: 'status.error' },
  aborted: { icon: X, color: 'text-muted-foreground bg-muted/50', labelKey: 'status.aborted' },
  paused: { icon: Pause, color: 'text-amber-400 bg-amber-500/10', labelKey: 'status.paused' },
};

export function AgentPane({ agent, onClick, onPause, onResume, onDelete }: AgentPaneProps) {
  const { t } = useTranslation('agents');
  const statusCfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.idle;
  const StatusIcon = statusCfg.icon;
  const currentText = agent.textChunks.join('');
  const activeToolCalls = agent.toolCalls.filter((t) => t.status === 'running');
  const completedCount = agent.toolCalls.filter((t) => t.status === 'done').length;
  const isMaster = agent.role === 'master';

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
      className={cn(
        'rounded-lg border bg-card overflow-hidden flex flex-col',
        onClick && 'cursor-pointer hover:bg-muted/30 transition-colors',
      )}
    >
      {/* Header */}
      <div className="px-2.5 py-1.5 border-b flex items-center gap-1.5 bg-muted/20">
        <div className={cn('h-4 w-4 rounded flex items-center justify-center shrink-0', statusCfg.color)}>
          <StatusIcon className={cn('h-2.5 w-2.5', statusCfg.spin && 'animate-spin')} />
        </div>
        {isMaster ? (
          <Crown className="h-3 w-3 text-yellow-400 shrink-0" />
        ) : (
          <Bot className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span className="text-[11px] font-medium capitalize truncate">{agent.role}</span>
        <Badge variant="outline" className="text-[9px] ml-auto shrink-0">
          {t(statusCfg.labelKey)}
        </Badge>
        {onDelete && (
          <AgentActions
            status={agent.status}
            onPause={() => onPause?.()}
            onResume={() => onResume?.()}
            onDelete={onDelete}
          />
        )}
      </div>

      {/* Compact content */}
      <div className="px-2.5 py-1.5 text-[10px] space-y-1">
        {/* Status message */}
        {agent.statusMessage && (
          <p className="text-muted-foreground italic truncate">{agent.statusMessage}</p>
        )}

        {/* Live activity pill — what the agent is doing RIGHT NOW (provider
            call / tool / operation) with a ticking "running Ns" counter.
            Reuses the exact chat pill so liveness is obvious at a glance. */}
        {agent.activity ? (
          <ActivityLineBlock activity={agent.activity} />
        ) : (
          activeToolCalls.length > 0 && (
            <div className="flex items-center gap-1 text-warning truncate">
              <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />
              <span className="font-mono truncate">{activeToolCalls[0].name}</span>
            </div>
          )
        )}

        {/* Current text (very short preview) */}
        {currentText && !agent.activity && !activeToolCalls.length && (
          <p className="text-foreground/70 truncate">
            {currentText.length > 80 ? `...${currentText.slice(-80)}` : currentText}
          </p>
        )}

        {/* Stats */}
        <div className="flex items-center gap-2 text-muted-foreground">
          {completedCount > 0 && (
            <span className="flex items-center gap-0.5">
              <Wrench className="h-2.5 w-2.5" />
              {completedCount}
            </span>
          )}
          {agent.usage && (
            <span className="tabular-nums">
              {formatTokens(agent.usage.input_tokens + agent.usage.output_tokens)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
