import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Bot, ListChecks, Loader2, Sparkles, Wrench } from 'lucide-react';
import type { ActiveProcess } from '../../../hooks/agent-stream/types.js';
import { selectVisibleActiveProcesses } from '../../../hooks/agent-stream/active-processes.js';
import { cn } from '../../../lib/utils.js';
import { CollapsibleSection } from './CollapsibleSection.js';

interface ActiveProcessesSectionProps {
  sessionId: number;
  processes: ActiveProcess[];
}

/** Live-only process monitor. The entire section unmounts when the list is empty. */
export function ActiveProcessesSection({ sessionId, processes }: ActiveProcessesSectionProps) {
  const { t } = useTranslation(['chat']);
  const visible = useMemo(() => (
    selectVisibleActiveProcesses(processes).sort((a, b) => a.startedAt - b.startedAt)
  ), [processes]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (visible.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [visible.length]);

  if (visible.length === 0) return null;

  return (
    <CollapsibleSection
      id="active-processes"
      sessionId={sessionId}
      title={t('chat:state.activeProcesses')}
      icon={<Loader2 className="h-3.5 w-3.5 animate-spin text-info" />}
      headerExtra={(
        <span className="inline-flex items-center gap-1 rounded bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
          {t('chat:state.activeProcessesCount', { count: visible.length })}
        </span>
      )}
      defaultOpen
    >
      <ul className="space-y-1 px-2 pb-2">
        {visible.map((process) => {
          const detail = process.note || readablePhase(process.phase) || t('chat:state.processRunning');
          const elapsed = Math.max(process.elapsedMs ?? 0, now - process.startedAt);
          return (
            <li
              key={process.id}
              className="rounded border border-border/60 bg-background/55 px-2 py-2"
            >
              <div className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 shrink-0 text-info">{processIcon(process)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground" title={process.label}>
                      {readableLabel(process.label)}
                    </span>
                    {process.background && (
                      <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[9px] text-primary">
                        {t('chat:state.processBackground')}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="shrink-0">
                      {t(`chat:state.processKind.${process.kind}`, { defaultValue: process.kind })}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate" title={detail}>{detail}</span>
                  </div>
                </div>
                <span
                  className={cn(
                    'shrink-0 tabular-nums text-[10px]',
                    process.status === 'waiting' ? 'text-warning' : 'text-muted-foreground',
                  )}
                  title={process.status === 'waiting' ? t('chat:state.processWaiting') : undefined}
                >
                  {process.status === 'waiting'
                    ? t('chat:state.processWaiting')
                    : formatElapsed(elapsed)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </CollapsibleSection>
  );
}

function processIcon(process: ActiveProcess): ReactNode {
  const className = 'h-3.5 w-3.5';
  if (process.kind === 'subagent' || process.kind === 'spawn_agent') return <Bot className={className} />;
  if (process.kind === 'task') return <ListChecks className={className} />;
  if (process.kind === 'tool') return <Wrench className={className} />;
  if (process.kind === 'provider') return <Sparkles className={className} />;
  return <Activity className={className} />;
}

function readableLabel(label: string): string {
  return label.replaceAll('_', ' ');
}

function readablePhase(phase?: string): string {
  if (!phase) return '';
  return phase.replaceAll('_', ' ');
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
