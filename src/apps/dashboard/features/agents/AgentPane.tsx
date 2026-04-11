import React from 'react';
import { Bot, Check, Clock, Loader2, X, Wrench, Crown, Pause, Eye, AlertTriangle } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import type { AgentStreamState } from '../../hooks/useCompanyStream.js';

interface AgentPaneProps {
  agent: AgentStreamState;
  onClick?: () => void;
}

const STATUS_CONFIG: Record<string, { icon: React.FC<{ className?: string }>; color: string; label: string; spin?: boolean }> = {
  idle: { icon: Clock, color: 'text-muted-foreground bg-muted/50', label: 'Idle' },
  running: { icon: Loader2, color: 'text-warning bg-warning/10', label: 'Running', spin: true },
  working: { icon: Loader2, color: 'text-blue-400 bg-blue-500/10', label: 'Working', spin: true },
  waiting: { icon: Pause, color: 'text-yellow-400 bg-yellow-500/10', label: 'Waiting' },
  waiting_plan: { icon: Clock, color: 'text-yellow-400 bg-yellow-500/10', label: 'Plan Review' },
  reviewing: { icon: Eye, color: 'text-cyan-400 bg-cyan-500/10', label: 'Reviewing' },
  blocked: { icon: AlertTriangle, color: 'text-orange-400 bg-orange-500/10', label: 'Blocked' },
  completed: { icon: Check, color: 'text-success bg-success/10', label: 'Done' },
  error: { icon: X, color: 'text-destructive bg-destructive/10', label: 'Error' },
  aborted: { icon: X, color: 'text-muted-foreground bg-muted/50', label: 'Aborted' },
};

export function AgentPane({ agent, onClick }: AgentPaneProps) {
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
          {statusCfg.label}
        </Badge>
      </div>

      {/* Compact content */}
      <div className="px-2.5 py-1.5 text-[10px] space-y-1">
        {/* Status message */}
        {agent.statusMessage && (
          <p className="text-muted-foreground italic truncate">{agent.statusMessage}</p>
        )}

        {/* Active tool call */}
        {activeToolCalls.length > 0 && (
          <div className="flex items-center gap-1 text-warning truncate">
            <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />
            <span className="font-mono truncate">{activeToolCalls[0].name}</span>
          </div>
        )}

        {/* Current text (very short preview) */}
        {currentText && !activeToolCalls.length && (
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
