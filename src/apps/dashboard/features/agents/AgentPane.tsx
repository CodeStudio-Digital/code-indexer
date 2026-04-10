import React from 'react';
import { Bot, Check, Clock, Loader2, X, Wrench } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import type { AgentStreamState } from '../../hooks/useCompanyStream.js';

interface AgentPaneProps {
  agent: AgentStreamState;
}

const STATUS_CONFIG = {
  idle: { icon: Clock, color: 'text-muted-foreground bg-muted/50', label: 'Idle' },
  running: { icon: Loader2, color: 'text-warning bg-warning/10', label: 'Running', spin: true },
  waiting_plan: { icon: Clock, color: 'text-yellow-400 bg-yellow-500/10', label: 'Awaiting Plan Approval' },
  completed: { icon: Check, color: 'text-success bg-success/10', label: 'Completed' },
  error: { icon: X, color: 'text-destructive bg-destructive/10', label: 'Error' },
} as const;

export function AgentPane({ agent }: AgentPaneProps) {
  const statusCfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.idle;
  const StatusIcon = statusCfg.icon;
  const currentText = agent.textChunks.join('');
  const activeToolCalls = agent.toolCalls.filter((t) => t.status === 'running');
  const completedToolCalls = agent.toolCalls.filter((t) => t.status === 'done');

  return (
    <div className="rounded-lg border bg-card overflow-hidden flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b flex items-center gap-2 bg-muted/30">
        <div className={cn('h-5 w-5 rounded-md flex items-center justify-center shrink-0', statusCfg.color)}>
          <StatusIcon className={cn('h-3 w-3', 'spin' in statusCfg && statusCfg.spin && 'animate-spin')} />
        </div>
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium capitalize">{agent.role}</span>
        <Badge variant="outline" className="text-[10px] ml-auto">
          {statusCfg.label}
        </Badge>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-2 text-xs space-y-2">
        {/* Active tool calls */}
        {activeToolCalls.map((tc) => (
          <div key={tc.id} className="flex items-center gap-1.5 text-warning">
            <Loader2 className="h-3 w-3 animate-spin shrink-0" />
            <span className="font-mono truncate">{tc.name}</span>
          </div>
        ))}

        {/* Current streaming text */}
        {currentText && (
          <div className="text-foreground/80 whitespace-pre-wrap break-words leading-relaxed">
            {currentText.length > 300 ? `...${currentText.slice(-300)}` : currentText}
          </div>
        )}

        {/* Completed tool calls count */}
        {completedToolCalls.length > 0 && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Wrench className="h-3 w-3" />
            <span>{completedToolCalls.length} tool call{completedToolCalls.length !== 1 ? 's' : ''} completed</span>
          </div>
        )}

        {/* Usage stats */}
        {agent.usage && (
          <div className="text-[10px] text-muted-foreground tabular-nums">
            {formatTokens(agent.usage.input_tokens + agent.usage.output_tokens)} tokens
          </div>
        )}

        {/* Done reason */}
        {agent.doneReason && (
          <div className={cn(
            'text-[10px] font-medium',
            agent.status === 'completed' ? 'text-success' : 'text-destructive',
          )}>
            {agent.doneReason}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
