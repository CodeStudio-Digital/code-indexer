import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Clock3, Loader2, Wrench, X } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import type { AgentStatus, ParallelAgent } from '../../../hooks/agent-stream/types.js';
import { Markdown } from '../messages/Markdown.js';
import type { ListedAgentsGroup } from './subagents-panel-data.js';

const TERMINAL_FAILURES = new Set<AgentStatus>(['error', 'timed_out', 'aborted']);

export function SubagentDetail({
  entry,
  selectedAgent,
  onSelectAgent,
}: {
  entry: ListedAgentsGroup;
  selectedAgent: ParallelAgent;
  onSelectAgent: (index: number) => void;
}) {
  const { t } = useTranslation('chat');
  const { group } = entry;
  const provider = formatProvider(selectedAgent.provider ?? group.provider, selectedAgent.model ?? group.model);
  const tokens = selectedAgent.usage
    ? selectedAgent.usage.input_tokens + selectedAgent.usage.output_tokens
    : null;
  const report = selectedAgent.error ?? selectedAgent.summary;
  const isError = Boolean(selectedAgent.error);
  const hasActivity = Boolean(
    selectedAgent.progressNote
      || selectedAgent.phase
      || selectedAgent.lastToolName
      || selectedAgent.turn != null
      || selectedAgent.elapsedMs != null,
  );

  return (
    <div className="space-y-3">
      {group.agents.length > 1 && (
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('subagentsPanel.agentList')}
          </div>
          <div className="flex flex-wrap gap-1.5" aria-label={t('subagentsPanel.agentList')}>
            {group.agents.map((agent) => (
              <button
                key={agent.index}
                type="button"
                aria-pressed={agent.index === selectedAgent.index}
                onClick={() => onSelectAgent(agent.index)}
                className={cn(
                  'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] transition-colors',
                  agent.index === selectedAgent.index
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <AgentStatusIcon status={agent.status} className="h-3 w-3" />
                <span className="max-w-[180px] truncate font-mono">{agent.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-background/70 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <AgentStatusIcon status={selectedAgent.status} className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground">
            {selectedAgent.label}
          </span>
          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
            {t(`subagentsPanel.status.${selectedAgent.status}`)}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {selectedAgent.agentType && (
            <Badge variant="outline" className="text-[10px]">{selectedAgent.agentType}</Badge>
          )}
          {selectedAgent.attempt != null && selectedAgent.attempt >= 2 && (
            <Badge variant="outline" className="border-warning/50 text-[10px] text-warning">
              {t('subagentsPanel.attempt', { attempt: selectedAgent.attempt })}
            </Badge>
          )}
          {provider && (
            <Badge variant="secondary" className="max-w-[220px] truncate text-[10px]" title={provider}>
              {provider}
            </Badge>
          )}
          <Badge variant="outline" className="gap-1 text-[10px] tabular-nums">
            <Wrench className="h-2.5 w-2.5" />
            {t('subagentsPanel.toolCalls', { count: selectedAgent.toolCallCount })}
          </Badge>
          {tokens != null && (
            <Badge variant="outline" className="text-[10px] tabular-nums">
              {t('subagentsPanel.tokens', { tokens: formatTokens(tokens) })}
            </Badge>
          )}
        </div>
      </div>

      {selectedAgent.task && (
        <DetailSection title={t('subagentsPanel.task')}>
          <div className="whitespace-pre-wrap rounded-md border bg-muted/25 p-2 text-xs leading-5 text-foreground/80">
            {selectedAgent.task}
          </div>
        </DetailSection>
      )}

      {hasActivity && (
        <DetailSection title={t('subagentsPanel.activity')}>
          <div className="space-y-1 rounded-md border bg-muted/25 p-2 text-[11px] text-muted-foreground">
            {selectedAgent.progressNote && (
              <div className="whitespace-pre-wrap text-foreground/80">{selectedAgent.progressNote}</div>
            )}
            {selectedAgent.phase && <MetaLine label={t('subagentsPanel.phase')} value={readable(selectedAgent.phase)} />}
            {selectedAgent.lastToolName && <MetaLine label={t('subagentsPanel.lastTool')} value={selectedAgent.lastToolName} mono />}
            {selectedAgent.turn != null && <MetaLine label={t('subagentsPanel.turn')} value={String(selectedAgent.turn)} />}
            {selectedAgent.elapsedMs != null && <MetaLine label={t('subagentsPanel.elapsed')} value={formatDuration(selectedAgent.elapsedMs)} />}
          </div>
        </DetailSection>
      )}

      <DetailSection title={t(isError ? 'subagentsPanel.error' : 'subagentsPanel.report')}>
        {report ? (
          isError ? (
            <pre className="whitespace-pre-wrap break-words rounded-md border border-destructive/40 p-2 font-mono text-[11px] text-destructive">
              {report}
            </pre>
          ) : (
            <Markdown text={report} />
          )
        ) : (
          <div className="text-xs italic text-muted-foreground">
            {t('subagentsPanel.noReport')}
          </div>
        )}
      </DetailSection>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function MetaLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="shrink-0">{label}</span>
      <span className={cn('min-w-0 flex-1 break-words text-right text-foreground/80', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  );
}

function AgentStatusIcon({ status, className }: { status: AgentStatus; className?: string }) {
  if (status === 'running') {
    return <Loader2 className={cn('shrink-0 animate-spin text-warning', className)} />;
  }
  if (status === 'pending') {
    return <Clock3 className={cn('shrink-0 text-muted-foreground', className)} />;
  }
  if (status === 'partial') {
    return <AlertTriangle className={cn('shrink-0 text-warning', className)} />;
  }
  if (TERMINAL_FAILURES.has(status)) {
    return <X className={cn('shrink-0 text-destructive', className)} />;
  }
  return <Check className={cn('shrink-0 text-success', className)} />;
}

function formatProvider(provider?: string, model?: string): string | null {
  if (provider && model) return `${provider}:${model}`;
  return provider ?? model ?? null;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(0, Math.round(ms / 1_000))}s`;
}

function readable(value: string): string {
  return value.replace(/[_:.-]+/g, ' ');
}
