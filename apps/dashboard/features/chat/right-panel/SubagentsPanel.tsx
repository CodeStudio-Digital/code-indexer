import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, Check, Loader2, X } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import type { AssistantTurn } from '../../../hooks/agent-stream/types.js';
import type { SessionData } from '../types.js';
import { SubagentDetail } from './SubagentDetail.js';
import {
  collectListedGroups,
  collectPersistedGroups,
  type ListedAgentsGroup,
} from './subagents-panel-data.js';

interface SubagentsPanelProps {
  sessionData: SessionData | null;
  currentTurn: AssistantTurn | null;
}

/**
 * Read-only projection over the same live agent groups rendered in the
 * transcript, plus groups reconstructed from persisted spawn tool calls.
 */
export function SubagentsPanel({ sessionData, currentTurn }: SubagentsPanelProps) {
  const { t } = useTranslation('chat');
  const history = useMemo(() => collectPersistedGroups(sessionData), [sessionData]);
  const { activeGroups, recentGroups } = useMemo(
    () => collectListedGroups(sessionData, currentTurn, history),
    [currentTurn, sessionData, history],
  );
  const allGroups = useMemo(
    () => [...activeGroups, ...recentGroups],
    [activeGroups, recentGroups],
  );
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState<number | null>(null);

  const selectedGroup =
    allGroups.find((entry) => entry.key === selectedGroupKey) ?? allGroups[0] ?? null;
  const selectedAgent = selectedGroup
    ? selectedGroup.group.agents.find((agent) => agent.index === selectedAgentIndex)
      ?? selectedGroup.group.agents.find((agent) => agent.status === 'running')
      ?? selectedGroup.group.agents[0]
      ?? null
    : null;

  const selectGroup = (entry: ListedAgentsGroup) => {
    setSelectedGroupKey(entry.key);
    setSelectedAgentIndex(
      entry.group.agents.find((agent) => agent.status === 'running')?.index
        ?? entry.group.agents[0]?.index
        ?? null,
    );
  };

  if (allGroups.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center">
        <div className="max-w-xs">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border bg-muted/30 text-muted-foreground">
            <Bot className="h-5 w-5" />
          </div>
          <div className="text-sm font-medium text-foreground">
            {t('subagentsPanel.emptyTitle')}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('subagentsPanel.emptyDescription')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="max-h-[42%] shrink-0 overflow-y-auto border-b bg-muted/10 px-2 py-2">
        {activeGroups.length > 0 && (
          <GroupSection
            title={t('subagentsPanel.active')}
            groups={activeGroups}
            selectedKey={selectedGroup?.key ?? null}
            onSelect={selectGroup}
          />
        )}
        {recentGroups.length > 0 && (
          <GroupSection
            title={t('subagentsPanel.recent')}
            groups={recentGroups}
            selectedKey={selectedGroup?.key ?? null}
            onSelect={selectGroup}
            className={activeGroups.length > 0 ? 'mt-3' : undefined}
          />
        )}
      </div>

      {selectedGroup && selectedAgent && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <SubagentDetail
            entry={selectedGroup}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedAgentIndex}
          />
        </div>
      )}
    </div>
  );
}

function GroupSection({
  title,
  groups,
  selectedKey,
  onSelect,
  className,
}: {
  title: string;
  groups: ListedAgentsGroup[];
  selectedKey: string | null;
  onSelect: (entry: ListedAgentsGroup) => void;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        <span className="text-[10px] tabular-nums text-muted-foreground">{groups.length}</span>
      </div>
      <div className="space-y-1">
        {groups.map((entry) => (
          <GroupListItem
            key={entry.key}
            entry={entry}
            selected={selectedKey === entry.key}
            onSelect={() => onSelect(entry)}
          />
        ))}
      </div>
    </section>
  );
}

function GroupListItem({
  entry,
  selected,
  onSelect,
}: {
  entry: ListedAgentsGroup;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('chat');
  const { group } = entry;
  const completedCount = group.agents.filter((agent) => agent.status === 'completed').length;
  const failed = group.agents.some((agent) => ['error', 'timed_out', 'aborted'].includes(agent.status));
  const partial = group.agents.some((agent) => agent.status === 'partial');
  const title = group.agents.length === 1
    ? group.agents[0]?.label ?? t('subagentsPanel.group', { count: 1 })
    : t('subagentsPanel.group', { count: group.agents.length });
  const provider = formatProvider(group.provider, group.model);

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
        selected
          ? 'border-primary/45 bg-primary/[0.08] shadow-sm'
          : 'border-border/70 bg-background/60 hover:border-border hover:bg-muted/40',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <GroupStatusIcon active={entry.active} failed={failed} partial={partial} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{title}</span>
        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] font-normal">
          {entry.source === 'live' ? t('subagentsPanel.live') : t('subagentsPanel.history')}
        </Badge>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-6 text-[10px] text-muted-foreground">
        <span className="tabular-nums">
          {t('subagentsPanel.progress', { completed: completedCount, total: group.agents.length })}
        </span>
        {group.background && <span>· {t('subagentsPanel.background')}</span>}
        {provider && <span className="min-w-0 truncate">· {provider}</span>}
      </div>
    </button>
  );
}

function GroupStatusIcon({ active, failed, partial }: { active: boolean; failed: boolean; partial: boolean }) {
  const base = 'flex h-4 w-4 shrink-0 items-center justify-center rounded';
  if (active) {
    return <span className={cn(base, 'bg-warning/10 text-warning')}><Loader2 className="h-2.5 w-2.5 animate-spin" /></span>;
  }
  if (failed) {
    return <span className={cn(base, 'bg-destructive/10 text-destructive')}><X className="h-2.5 w-2.5" /></span>;
  }
  if (partial) {
    return <span className={cn(base, 'bg-warning/10 text-warning')}><AlertTriangle className="h-2.5 w-2.5" /></span>;
  }
  return <span className={cn(base, 'bg-success/10 text-success')}><Check className="h-2.5 w-2.5" /></span>;
}

function formatProvider(provider?: string, model?: string): string | null {
  if (provider && model) return `${provider}:${model}`;
  return provider ?? model ?? null;
}
