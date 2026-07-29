import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, CircleDot, Clock3, ShieldCheck } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import type { AppDecisionView, AppStudioSessionDetail } from '../app-studio-api.js';
import { answerAppDecision, runAppAction } from '../app-studio-api.js';

function Decision({ appId, decision, onChanged }: { appId: string; decision: AppDecisionView; onChanged: () => void }) {
  const { t } = useTranslation('appStudio');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <article className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-sm font-medium">{decision.question}</p>
      {decision.options.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{decision.options.map((option, index) => (
        <button key={option.value ?? index} className="rounded border bg-background px-2 py-1 text-xs" onClick={() => setAnswer(option.value ?? option.label ?? '')}>{option.label ?? option.value}</button>
      ))}</div>}
      <div className="mt-2 flex gap-2">
        <input value={answer} onChange={(event) => setAnswer(event.target.value)} className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-xs" placeholder={t('v6.decisionPlaceholder')} />
        <Button size="sm" disabled={!answer.trim() || busy} onClick={() => void (async () => {
          setBusy(true);
          try { await answerAppDecision(appId, decision.id, answer.trim()); onChanged(); } finally { setBusy(false); }
        })()}>{t('v6.answer')}</Button>
      </div>
    </article>
  );
}

export function PlanPanel({ detail, onChanged }: { detail: AppStudioSessionDetail; onChanged: () => void }) {
  const { t } = useTranslation('appStudio');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = detail.plan_revision;
  const plan = revision?.plan;
  const fitness = revision?.fitness;
  const ready = revision?.status === 'draft' && fitness?.status === 'ready';
  const workDone = detail.work_items.filter((item) => item.status === 'done').length;
  const openDecisions = detail.decisions.filter((item) => item.status === 'open');
  const progress = detail.stage === 'planning' ? 0 : detail.stage === 'building' ? 1 : detail.stage === 'reviewing' ? 2 : detail.stage === 'ready' ? 3 : 4;
  const stages = [t('v6.stages.planning'), t('v6.stages.building'), t('v6.stages.reviewing'), t('v6.stages.ready'), t('v6.stages.live')];

  const approve = async () => {
    setBusy(true); setError(null);
    try { await runAppAction(detail.session.id, 'approve_plan_and_build'); onChanged(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <section className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('v6.plan')}</p>
            <h2 className="mt-1 text-lg font-semibold">{plan?.intent.summary || t('v6.planEmpty')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{plan?.intent.audience ? t('v6.forAudience', { audience: plan.intent.audience }) : t('v6.describeInChat')}</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${fitness?.status === 'ready' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700'}`}>
            {fitness?.status === 'ready' ? t('v6.fitnessReady') : t('v6.fitnessBlocked')}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-5 gap-1">
          {stages.map((label, index) => <div key={label} className="text-center"><div className={`mx-auto mb-1 h-1.5 rounded-full ${index <= progress ? 'bg-primary' : 'bg-muted'}`} /><span className={`text-[10px] ${index === progress ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{label}</span></div>)}
        </div>
        {ready && <div className="mt-4 flex justify-end"><Button disabled={busy} onClick={() => void approve()}><ShieldCheck className="mr-1.5 h-4 w-4" />{t('v6.approveAndBuild')}</Button></div>}
        {error && <p className="mt-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700">{error}</p>}
      </section>

      {openDecisions.length > 0 && <section className="space-y-2"><h3 className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-500" />{t('v6.pendingDecisions')}</h3>{openDecisions.map((decision) => <Decision key={decision.id} appId={detail.session.id} decision={decision} onChanged={onChanged} />)}</section>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-4">
          <h3 className="text-sm font-semibold">{t('v6.scopeExperience')}</h3>
          <div className="mt-3 space-y-3 text-xs">
            <div><p className="font-medium text-muted-foreground">{t('v6.goals')}</p><ul className="mt-1 space-y-1">{(plan?.intent.goals ?? []).map((item) => <li key={item.id}>• {item.text}</li>)}</ul></div>
            <div><p className="font-medium text-muted-foreground">{t('v6.capabilities')}</p><div className="mt-1 flex flex-wrap gap-1">{(plan?.scope.capabilities ?? []).filter((item) => item.selected).map((item) => <span key={item.id} className="rounded bg-primary/10 px-2 py-1">{item.name}</span>)}</div></div>
            <div><p className="font-medium text-muted-foreground">{t('v6.screens')}</p><div className="mt-1 flex flex-wrap gap-1">{(plan?.experience.screens ?? []).map((item) => <span key={item.id} className="rounded bg-muted px-2 py-1">{item.name}</span>)}</div></div>
          </div>
        </section>
        <section className="rounded-xl border bg-card p-4">
          <h3 className="text-sm font-semibold">{t('v6.technicalDecisions')}</h3>
          <div className="mt-3 space-y-2 text-xs">
            {(plan?.engineering.components ?? []).map((component) => <div key={component.id} className="rounded border p-2"><div className="flex items-center gap-2"><CircleDot className="h-3 w-3 text-primary" /><strong>{component.name}</strong><span className="ml-auto text-[10px] text-muted-foreground">{component.kind}</span></div><p className="mt-1 text-muted-foreground">{component.responsibility}</p></div>)}
            {(plan?.engineering.components.length ?? 0) === 0 && <p className="text-muted-foreground">{t('v6.noDecorativeInfra')}</p>}
          </div>
        </section>
      </div>

      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2"><h3 className="flex-1 text-sm font-semibold">{t('v6.progressEvidence')}</h3><span className="text-xs text-muted-foreground">{workDone}/{detail.work_items.length}</span></div>
        <div className="mt-3 space-y-2">{detail.work_items.length === 0 ? <p className="text-xs text-muted-foreground">{t('v6.workAfterApproval')}</p> : detail.work_items.map((item) => (
          <div key={item.id} className="flex items-start gap-2 rounded border p-2.5"><span className={`mt-0.5 h-2 w-2 rounded-full ${item.status === 'done' ? 'bg-emerald-500' : item.status === 'blocked' ? 'bg-red-500' : item.status === 'running' ? 'bg-blue-500' : 'bg-muted-foreground/40'}`} /><div className="min-w-0 flex-1"><p className="text-xs font-medium">{item.title}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{t(`v6.workStatus.${item.status}`)}{item.evidence.length > 0 ? ` · ${t('v6.evidenceCount', { count: item.evidence.length })}` : ''}</p>{item.blocked_reason && <p className="mt-1 text-[10px] text-red-600">{item.blocked_reason}</p>}</div></div>
        ))}</div>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="h-4 w-4" />{t('v6.readiness')}</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{(fitness?.checks ?? []).map((check) => <div key={check.id} className={`rounded border p-2 text-xs ${check.status === 'pass' ? 'border-emerald-500/20' : 'border-red-500/30 bg-red-500/5'}`}><p className="font-medium">{check.title}</p><p className="mt-1 text-muted-foreground">{check.detail}</p>{check.action && check.status === 'fail' && <p className="mt-1 text-red-700">{check.action}</p>}</div>)}</div>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Clock3 className="h-4 w-4" />{t('v6.history')}</h3>
        <div className="mt-2 flex flex-wrap gap-2">{detail.plan_history.map((item) => <span key={item.id} className="rounded border px-2 py-1 text-[10px]">{t('v6.revision', { revision: item.revision_number, status: item.status })}</span>)}</div>
      </section>
    </div>
  );
}
