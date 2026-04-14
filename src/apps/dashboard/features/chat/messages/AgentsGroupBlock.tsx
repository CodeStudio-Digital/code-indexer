import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import type { AgentsGroup, ParallelAgent } from '../../../hooks/useAgentStream.js';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from './Markdown.js';

interface AgentsGroupBlockProps {
  group: AgentsGroup;
}

export const AgentsGroupBlock = React.memo(AgentsGroupBlockInner, (prev, next) => {
  // Re-render when any agent's status, toolCallCount, or summary changes,
  // or when the group status/totalUsage changes.
  if (prev.group.status !== next.group.status) return false;
  if (prev.group.totalUsage !== next.group.totalUsage) return false;
  if (prev.group.agents.length !== next.group.agents.length) return false;
  for (let i = 0; i < prev.group.agents.length; i++) {
    const a = prev.group.agents[i];
    const b = next.group.agents[i];
    if (
      a.status !== b.status ||
      a.toolCallCount !== b.toolCallCount ||
      a.summary !== b.summary ||
      a.error !== b.error
    )
      return false;
  }
  return true;
});

function AgentsGroupBlockInner({ group }: AgentsGroupBlockProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(true);
  const [expandedAgents, setExpandedAgents] = useState<Set<number>>(new Set());

  const isRunning = group.status === 'running';
  const completedCount = group.agents.filter((a) => a.status === 'completed').length;
  const totalToolCalls = group.agents.reduce((sum, a) => sum + a.toolCallCount, 0);

  const toggleAgent = (index: number) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="my-2 rounded-lg border bg-muted/30 overflow-hidden text-xs">
      {/* Group header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-muted/60 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <div
          className={cn(
            'h-5 w-5 rounded-md flex items-center justify-center shrink-0',
            isRunning ? 'text-warning bg-warning/10' : 'text-success bg-success/10',
          )}
        >
          {isRunning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
        </div>
        <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium text-foreground">
          {t('agentGroup.parallelAgents', { count: group.agents.length })}
        </span>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {t('agentGroup.toolCalls', { count: totalToolCalls })}
        </Badge>
        {!isRunning && (
          <span className="text-muted-foreground tabular-nums">
            {t('agentGroup.completed', { completed: completedCount, total: group.agents.length })}
          </span>
        )}
        {group.totalUsage && (
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0">
            {t('agentGroup.tokens', { tokens: formatTokens(group.totalUsage.input_tokens + group.totalUsage.output_tokens) })}
          </span>
        )}
      </button>

      {/* Agent rows */}
      {expanded && (
        <div className="border-t">
          {group.agents.map((agent) => (
            <AgentRow
              key={agent.index}
              agent={agent}
              isExpanded={expandedAgents.has(agent.index)}
              onToggle={() => toggleAgent(agent.index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface AgentRowProps {
  agent: ParallelAgent;
  isExpanded: boolean;
  onToggle: () => void;
}

function AgentRow({ agent, isExpanded, onToggle }: AgentRowProps) {
  const StatusIcon =
    agent.status === 'running' || agent.status === 'pending'
      ? Loader2
      : agent.status === 'error'
        ? X
        : Check;
  const statusColor =
    agent.status === 'error'
      ? 'text-destructive bg-destructive/10'
      : agent.status === 'running' || agent.status === 'pending'
        ? 'text-warning bg-warning/10'
        : 'text-success bg-success/10';

  const hasSummary = agent.summary || agent.error;

  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={hasSummary ? onToggle : undefined}
        className={cn(
          'w-full px-3 py-2 flex items-center gap-2 text-left transition-colors',
          hasSummary && 'hover:bg-muted/60 cursor-pointer',
          !hasSummary && 'cursor-default',
        )}
      >
        {hasSummary ? (
          <ChevronRight
            className={cn(
              'h-3 w-3 text-muted-foreground transition-transform shrink-0',
              isExpanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <div className={cn('h-4 w-4 rounded flex items-center justify-center shrink-0', statusColor)}>
          <StatusIcon
            className={cn(
              'h-2.5 w-2.5',
              (agent.status === 'running' || agent.status === 'pending') && 'animate-spin',
            )}
          />
        </div>
        <span className="font-mono text-foreground/80 truncate">{agent.label}</span>
        <Badge variant="outline" className="shrink-0 tabular-nums text-[10px]">
          {agent.toolCallCount} tool{agent.toolCallCount !== 1 ? 's' : ''}
        </Badge>
        {agent.usage && (
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0 text-[10px]">
            {formatTokens(agent.usage.input_tokens + agent.usage.output_tokens)}
          </span>
        )}
      </button>
      {isExpanded && hasSummary && (
        <div className="px-4 pb-3 pt-1 border-t bg-background/50">
          {agent.error ? (
            <pre className="font-mono text-[11px] text-destructive whitespace-pre-wrap break-all">
              {agent.error}
            </pre>
          ) : (
            <div className="text-[11px] text-foreground/80">
              <Markdown text={agent.summary!} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
