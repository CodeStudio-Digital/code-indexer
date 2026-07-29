import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  GitBranch,
  Loader2,
  Play,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { formatClock } from '../../lib/datetime.js';
import { cn } from '../../lib/utils.js';
import {
  answerAppDecision,
  runAppAction,
  type AppDecisionView,
  type AppRecentEventView,
  type AppStudioSessionDetail,
  type AppWorkAttemptView,
  type AppWorkItemStatus,
  type AppWorkItemView,
} from './app-studio-api.js';

export type AppWorkGroup = 'active' | 'ready' | 'blocked' | 'queued' | 'completed' | 'cancelled';

const GROUP_ORDER: AppWorkGroup[] = ['active', 'ready', 'blocked', 'queued', 'completed', 'cancelled'];
const STATUS_GROUP: Record<AppWorkItemStatus, AppWorkGroup> = {
  running: 'active',
  review: 'active',
  ready: 'ready',
  blocked: 'blocked',
  stale: 'blocked',
  backlog: 'queued',
  done: 'completed',
  cancelled: 'cancelled',
};

const STATUS_DOT: Record<AppWorkItemStatus, string> = {
  running: 'bg-blue-400 shadow-[0_0_0_3px_rgb(96_165_250/0.12)]',
  review: 'bg-violet-400',
  ready: 'bg-emerald-400',
  blocked: 'bg-red-400',
  stale: 'bg-amber-400',
  backlog: 'bg-muted-foreground/35',
  done: 'bg-emerald-500',
  cancelled: 'bg-muted-foreground/20',
};

export function groupAppWorkItems(items: AppWorkItemView[]): Array<{ group: AppWorkGroup; items: AppWorkItemView[] }> {
  const grouped = new Map<AppWorkGroup, AppWorkItemView[]>();
  for (const item of items) {
    const group = STATUS_GROUP[item.status];
    const list = grouped.get(group) ?? [];
    list.push(item);
    grouped.set(group, list);
  }
  return GROUP_ORDER.flatMap((group) => {
    const rows = grouped.get(group);
    if (!rows?.length) return [];
    return [{
      group,
      items: [...rows].sort((a, b) => b.priority - a.priority || a.sort_order - b.sort_order),
    }];
  });
}

export function currentWorkAttempt(item: AppWorkItemView): AppWorkAttemptView | null {
  if (item.active_attempt) return item.active_attempt;
  if (item.latest_attempt) return item.latest_attempt;
  if (!item.attempts?.length) return null;
  return [...item.attempts].sort((a, b) => b.attempt - a.attempt || b.seq - a.seq)[0] ?? null;
}

export interface AppWorkRuntimeSummary {
  role: string;
  agentRunId: string | null;
  attempt: number | null;
}

export function workRuntimeSummary(item: AppWorkItemView, events: AppRecentEventView[]): AppWorkRuntimeSummary | null {
  const attempt = currentWorkAttempt(item);
  if (attempt) return { role: attempt.role || item.owner_role, agentRunId: attempt.company_agent_run_id, attempt: attempt.attempt };
  const dispatch = [...events]
    .sort((a, b) => b.seq - a.seq)
    .find((event) => recentEventKind(event) === 'agents.specialist_dispatched' && event.payload?.work_item_id === item.id);
  if (!dispatch) return null;
  const role = typeof dispatch.payload?.role === 'string' ? dispatch.payload.role : item.owner_role;
  const agentRunId = typeof dispatch.payload?.company_agent_run_id === 'string' ? dispatch.payload.company_agent_run_id : null;
  const attemptNumber = typeof dispatch.payload?.attempt === 'number' ? dispatch.payload.attempt : null;
  return { role, agentRunId, attempt: attemptNumber };
}

export function recentEventKind(event: AppRecentEventView): string {
  return event.kind ?? event.event_type ?? 'workflow.updated';
}

function DecisionCard({ appId, decision, onChanged }: { appId: string; decision: AppDecisionView; onChanged: () => void }) {
  const { t } = useTranslation('appStudio');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await answerAppDecision(appId, decision.id, answer.trim());
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
      <p className="text-xs font-medium leading-5">{decision.question}</p>
      {decision.blocked_work_item_ids.length > 0 && (
        <p className="mt-1 text-[10px] text-amber-600">
          {t('v6.orchestration.blocksWork', { count: decision.blocked_work_item_ids.length })}
        </p>
      )}
      {decision.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {decision.options.map((option, index) => {
            const value = option.value ?? option.label ?? '';
            return <button key={`${value}-${index}`} type="button" className="rounded border bg-background px-2 py-1 text-[10px] hover:bg-accent" onClick={() => setAnswer(value)}>{option.label ?? option.value}</button>;
          })}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-[11px] outline-none focus:border-primary"
          placeholder={t('v6.decisionPlaceholder')}
        />
        <Button size="sm" className="h-7 px-2" disabled={!answer.trim() || busy} onClick={() => void submit()}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : t('v6.answer')}
        </Button>
      </div>
      {error && <p className="mt-1.5 text-[10px] text-red-600">{error}</p>}
    </article>
  );
}

function WorkCard({ item, events }: { item: AppWorkItemView; events: AppRecentEventView[] }) {
  const { t } = useTranslation('appStudio');
  const attempt = currentWorkAttempt(item);
  const runtime = workRuntimeSummary(item, events);
  const agentLabel = runtime?.agentRunId && runtime.attempt != null
    ? t('v6.orchestration.agentAttempt', { role: runtime.role, agent: runtime.agentRunId, attempt: runtime.attempt })
    : runtime?.attempt != null
      ? t('v6.orchestration.attempt', { role: runtime.role, attempt: runtime.attempt })
      : item.owner_role;

  return (
    <article className={cn('rounded-md border bg-card p-2.5', item.status === 'running' && 'border-blue-500/30 bg-blue-500/[0.04]', item.status === 'blocked' && 'border-red-500/30')}>
      <div className="flex items-start gap-2">
        <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', STATUS_DOT[item.status])} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium leading-4">{item.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span>{t(`v6.workStatus.${item.status}`)}</span>
            <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" />{agentLabel}</span>
            {item.depends_on.length > 0 && <span className="inline-flex items-center gap-1" title={item.depends_on.join(', ')}><GitBranch className="h-3 w-3" />{t('v6.orchestration.dependencies', { count: item.depends_on.length })}</span>}
            {item.evidence.length > 0 && <span>{t('v6.evidenceCount', { count: item.evidence.length })}</span>}
          </div>
          {attempt?.status_message && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{attempt.status_message}</p>}
          {item.blocked_reason && <p className="mt-1 rounded bg-red-500/10 px-1.5 py-1 text-[10px] leading-4 text-red-600">{item.blocked_reason}</p>}
        </div>
      </div>
    </article>
  );
}

function eventSummary(event: AppRecentEventView): string | null {
  const payload = event.payload ?? {};
  for (const key of ['title', 'message', 'reason', 'error', 'status_message', 'role', 'status', 'mode']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function Timeline({ events }: { events: AppRecentEventView[] }) {
  const { t } = useTranslation('appStudio');
  const rows = [...events].sort((a, b) => b.seq - a.seq).slice(0, 12);
  if (!rows.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{t('v6.orchestration.timeline')}</h3>
      <div className="relative space-y-0.5 border-l border-border/70 pl-3">
        {rows.map((event) => {
          const kind = recentEventKind(event);
          const summary = eventSummary(event);
          return (
            <div key={event.id} className="relative py-1.5 text-[10px]">
              <span className="absolute -left-[15.5px] top-2.5 h-1.5 w-1.5 rounded-full bg-primary" />
              <div className="flex items-start gap-2"><span className="min-w-0 flex-1 font-medium">{t(`v6.orchestration.events.${kind}`, { defaultValue: kind })}</span><time className="shrink-0 text-muted-foreground">{formatClock(event.created_at, { hour: '2-digit', minute: '2-digit' })}</time></div>
              {summary && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{summary}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function AppStudioOrchestrationBoard({ detail, onChanged }: { detail: AppStudioSessionDetail; onChanged: () => void }) {
  const { t } = useTranslation('appStudio');
  const [busy, setBusy] = useState<'approve' | 'dispatch' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openDecisions = detail.decisions.filter((decision) => decision.status === 'open');
  const approvalPending = detail.plan_revision?.status === 'draft' && detail.plan_revision.fitness?.status === 'ready';
  const readyCount = detail.work_items.filter((item) => item.status === 'ready').length;
  const groups = useMemo(() => groupAppWorkItems(detail.work_items), [detail.work_items]);
  const doneCount = detail.work_items.filter((item) => item.status === 'done').length;

  const run = async (action: 'approve' | 'dispatch') => {
    setBusy(action);
    setError(null);
    try {
      await runAppAction(detail.session.id, action === 'approve' ? 'approve_plan_and_build' : 'dispatch_ready_work');
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="space-y-4 pb-2">
        <section className="rounded-lg border bg-card p-3">
          <div className="flex items-start gap-2">
            <Activity className="mt-0.5 h-4 w-4 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{t('v6.orchestration.statusTitle')}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{t('v6.orchestration.progress', { done: doneCount, total: detail.work_items.length, decisions: openDecisions.length })}</p>
            </div>
            <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" disabled={busy != null || readyCount === 0} onClick={() => void run('dispatch')} title={readyCount === 0 ? t('v6.orchestration.noReadyWork') : undefined}>
              {busy === 'dispatch' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {t('v6.orchestration.dispatchReady', { count: readyCount })}
            </Button>
          </div>
        </section>

        {approvalPending && (
          <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.07] p-3">
            <div className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /><div className="min-w-0 flex-1"><p className="text-xs font-semibold">{t('v6.orchestration.approvalTitle')}</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{t('v6.orchestration.approvalBody')}</p></div></div>
            <Button size="sm" className="mt-2.5 w-full" disabled={busy != null} onClick={() => void run('approve')}>
              {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}{t('v6.approveAndBuild')}
            </Button>
          </section>
        )}

        {openDecisions.length > 0 && (
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-600"><AlertTriangle className="h-3.5 w-3.5" />{t('v6.pendingDecisions')}<span className="rounded-full bg-amber-500/15 px-1.5 py-0.5">{openDecisions.length}</span></h3>
            {openDecisions.map((decision) => <DecisionCard key={decision.id} appId={detail.session.id} decision={decision} onChanged={onChanged} />)}
          </section>
        )}

        <section className="space-y-3">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" />{t('v6.orchestration.workTitle')}</h3>
          {groups.length === 0 && <p className="rounded-md border border-dashed p-3 text-center text-[10px] text-muted-foreground">{t('v6.workAfterApproval')}</p>}
          {groups.map(({ group, items }) => (
            <div key={group} className="space-y-1.5">
              <div className="flex items-center gap-2"><p className="text-[10px] font-medium text-muted-foreground">{t(`v6.orchestration.groups.${group}`)}</p><span className="h-px flex-1 bg-border/70" /><span className="text-[9px] text-muted-foreground">{items.length}</span></div>
              {items.map((item) => <WorkCard key={item.id} item={item} events={detail.recent_events ?? []} />)}
            </div>
          ))}
        </section>

        <Timeline events={detail.recent_events ?? []} />
        {error && <p className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[10px] text-red-600">{error}</p>}
      </div>
    </div>
  );
}
