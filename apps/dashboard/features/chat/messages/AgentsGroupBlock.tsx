import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, ChevronDown, ChevronRight, Loader2, Maximize2, X } from 'lucide-react';
import type { AgentsGroup, ParallelAgent } from '../../../hooks/useAgentStream.js';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import { AgentDetailModal } from './AgentDetailModal.js';

interface AgentsGroupBlockProps {
  group: AgentsGroup;
  resultSource?: AgentsGroupResultSource;
}

export interface AgentsGroupResultSource {
  sessionId: number;
  toolUseId: string;
  input?: Record<string, unknown>;
  isTruncated?: boolean;
}

export const AgentsGroupBlock = React.memo(AgentsGroupBlockInner, (prev, next) => {
  // Re-render when any agent's status, toolCallCount, or summary changes,
  // or when the group status/totalUsage changes.
  if (prev.group.status !== next.group.status) return false;
  if (prev.group.totalUsage !== next.group.totalUsage) return false;
  if (prev.group.provider !== next.group.provider) return false;
  if (prev.group.model !== next.group.model) return false;
  if (prev.resultSource?.sessionId !== next.resultSource?.sessionId) return false;
  if (prev.resultSource?.toolUseId !== next.resultSource?.toolUseId) return false;
  if (prev.resultSource?.isTruncated !== next.resultSource?.isTruncated) return false;
  if (prev.resultSource?.input !== next.resultSource?.input) return false;
  if (prev.group.agents.length !== next.group.agents.length) return false;
  for (let i = 0; i < prev.group.agents.length; i++) {
    const a = prev.group.agents[i];
    const b = next.group.agents[i];
    if (
      a.status !== b.status ||
      a.toolCallCount !== b.toolCallCount ||
      a.provider !== b.provider ||
      a.model !== b.model ||
      a.summary !== b.summary ||
      a.error !== b.error ||
      a.progressNote !== b.progressNote ||
      a.phase !== b.phase ||
      a.turn !== b.turn ||
      a.elapsedMs !== b.elapsedMs ||
      a.idleMs !== b.idleMs ||
      a.deadlineMs !== b.deadlineMs ||
      a.lastToolName !== b.lastToolName ||
      a.usage !== b.usage
    )
      return false;
  }
  return true;
});

function AgentsGroupBlockInner({ group, resultSource }: AgentsGroupBlockProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(true);
  const [openAgent, setOpenAgent] = useState<number | null>(null);

  const isRunning = group.status === 'running';
  const completedCount = group.agents.filter((a) => a.status === 'completed').length;
  const totalToolCalls = group.agents.reduce((sum, a) => sum + a.toolCallCount, 0);
  const providerLabel = formatProviderLabel(group.provider, group.model);
  const openAgentEntry = openAgent !== null ? group.agents.find((a) => a.index === openAgent) : undefined;

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
          {group.agents.length === 1
            ? t('agentGroup.singleAgent', { defaultValue: 'subagent' })
            : t('agentGroup.parallelAgents', { count: group.agents.length })}
        </span>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {t('agentGroup.toolCalls', { count: totalToolCalls })}
        </Badge>
        {providerLabel && (
          <Badge
            variant="secondary"
            className="shrink min-w-0 max-w-[220px] truncate text-[10px]"
            title={providerLabel}
          >
            {providerLabel}
          </Badge>
        )}
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
              onOpen={() => setOpenAgent(agent.index)}
            />
          ))}
        </div>
      )}

      {openAgentEntry && (
        <AgentDetailModal
          agent={openAgentEntry}
          resultSource={resultSource}
          open
          onOpenChange={(o) => {
            if (!o) setOpenAgent(null);
          }}
        />
      )}
    </div>
  );
}

interface AgentRowProps {
  agent: ParallelAgent;
  onOpen: () => void;
}

function AgentRow({ agent, onOpen }: AgentRowProps) {
  const StatusIcon =
    agent.status === 'running' || agent.status === 'pending'
      ? Loader2
      : agent.status === 'error' || agent.status === 'timed_out' || agent.status === 'aborted'
        ? X
        : Check;
  const statusColor =
    agent.status === 'error' || agent.status === 'timed_out' || agent.status === 'aborted'
      ? 'text-destructive bg-destructive/10'
      : agent.status === 'running' || agent.status === 'pending'
        ? 'text-warning bg-warning/10'
        : 'text-success bg-success/10';

  // Any agent that reached a terminal state is openable — even when it produced
  // no summary (e.g. a weak model ended its turn with empty text). Running/pending
  // rows stay non-clickable; they show their progress via AgentActivityLine.
  const isFinished =
    agent.status === 'completed' ||
    agent.status === 'error' ||
    agent.status === 'timed_out' ||
    agent.status === 'aborted';
  const providerLabel = formatProviderLabel(agent.provider, agent.model);
  const runningMeta = formatRunningMeta(agent);

  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={isFinished ? onOpen : undefined}
        title={isFinished ? 'Open agent detail' : undefined}
        className={cn(
          'w-full px-3 py-2 flex items-center gap-2 text-left transition-colors',
          isFinished && 'hover:bg-muted/60 cursor-pointer',
          !isFinished && 'cursor-default',
        )}
      >
        {isFinished ? (
          <Maximize2 className="h-3 w-3 text-muted-foreground shrink-0" />
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
        {providerLabel && (
          <Badge
            variant="secondary"
            className="shrink min-w-0 max-w-[180px] truncate text-[10px]"
            title={providerLabel}
          >
            {providerLabel}
          </Badge>
        )}
        {agent.usage && (
          <span className="ml-auto text-muted-foreground tabular-nums shrink-0 text-[10px]">
            {formatTokens(agent.usage.input_tokens + agent.usage.output_tokens)}
          </span>
        )}
      </button>
      {agent.status === 'running' && (agent.progressNote || agent.phase || agent.lastToolName) && (
        <AgentActivityLine agent={agent} runningMeta={runningMeta} />
      )}
    </div>
  );
}

function AgentActivityLine({ agent, runningMeta }: { agent: ParallelAgent; runningMeta: string }) {
  const phase = agent.phase ? readable(agent.phase) : 'running';
  const label = agent.lastToolName ?? activityLabelFromPhase(agent.phase) ?? 'subagent';
  const note = agent.progressNote ?? agent.lastToolName ?? '';
  return (
    <div className="px-8 pb-2">
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/45 px-2 py-1 text-[11px]">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-warning" />
        <span className="min-w-0 truncate font-mono font-medium text-foreground/80">{label}</span>
        <span className="shrink-0 text-muted-foreground">{phase}</span>
        {note && note !== label && (
          <span className="min-w-0 truncate text-muted-foreground">{note}</span>
        )}
        {runningMeta && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{runningMeta}</span>
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

function formatProviderLabel(provider?: string, model?: string): string | null {
  if (!provider && !model) return null;
  if (provider && model) return `${provider}:${model}`;
  return provider ?? model ?? null;
}

function activityLabelFromPhase(phase?: string): string | null {
  if (!phase) return null;
  if (phase.includes('provider')) return 'provider.chat';
  if (phase.includes('thinking')) return 'thinking';
  if (phase.includes('text')) return 'streaming text';
  return null;
}

function readable(value: string): string {
  return value.replace(/[_:.-]+/g, ' ');
}

function formatRunningMeta(agent: ParallelAgent): string {
  const parts: string[] = [];
  if (agent.idleMs != null) parts.push(`idle ${formatMs(agent.idleMs)}`);
  if (agent.deadlineMs != null && agent.elapsedMs != null) {
    parts.push(`left ${formatMs(Math.max(0, agent.deadlineMs - agent.elapsedMs))}`);
  }
  return parts.join(', ');
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}
