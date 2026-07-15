import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowRight, ArrowUp, CheckSquare, CirclePause, CirclePlay, Clock, FileCode2, Link2, RotateCcw, ShieldCheck, Users, X } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { WorkBoardBadge, WorkBoardDetailDialog, WorkBoardProgress, WorkBoardSection, type WorkBoardTone } from '../../../components/work-board/index.js';
import type { AppWorkItemView } from '../app-studio-api.js';

type WorkAction = 'reorder' | 'pause' | 'resume' | 'cancel' | 'request_changes';

const STATUS_TONE: Partial<Record<AppWorkItemView['status'], WorkBoardTone>> = {
  ready: 'blue', running: 'amber', review: 'violet', done: 'green', blocked: 'red', stale: 'amber', cancelled: 'red',
};

export function AppWorkItemDialog({ item, allItems, index, count, busy, onClose, onSelectItem, onAction }: { item: AppWorkItemView; allItems: AppWorkItemView[]; index: number; count: number; busy: boolean; onClose: () => void; onSelectItem: (id: string) => void; onAction: (action: WorkAction, value?: string | number) => void }) {
  const { t } = useTranslation('appStudio');
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState('');
  const done = item.status === 'done';
  const progress = done ? item.acceptance.length : Math.min(item.evidence.length, item.acceptance.length);
  const mutable = item.status === 'backlog' || item.status === 'ready';

  const footer = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1 text-[10px] text-muted-foreground"><Clock className="h-3 w-3" /><span className="truncate">{t('workflow.revision', { number: item.revision })} · {new Date(item.updated_at).toLocaleString()}</span></div>
      {item.status === 'running' || item.status === 'ready' ? <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('pause')}><CirclePause className="mr-1 h-3.5 w-3.5" />{t('workflow.pause')}</Button> : item.status === 'blocked' ? <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction('resume')}><CirclePlay className="mr-1 h-3.5 w-3.5" />{t('workflow.resume')}</Button> : null}
      {item.status !== 'cancelled' && <Button variant="outline" size="sm" disabled={busy} onClick={() => setChanging((value) => !value)}><RotateCcw className="mr-1 h-3.5 w-3.5" />{t('workflow.requestChanges')}</Button>}
      {!['done', 'cancelled'].includes(item.status) && <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => onAction('cancel')}><X className="mr-1 h-3.5 w-3.5" />{t('workflow.cancel')}</Button>}
    </>
  );

  return (
    <WorkBoardDetailDialog
      open
      onClose={onClose}
      badges={<><WorkBoardBadge>#{item.id}</WorkBoardBadge><WorkBoardBadge tone={STATUS_TONE[item.status] ?? 'neutral'}>{item.status}</WorkBoardBadge><WorkBoardBadge tone={item.kind === 'verify' ? 'green' : item.kind === 'release' ? 'violet' : 'blue'}>{item.kind}</WorkBoardBadge><WorkBoardBadge>{t(`workflow.phases.${item.phase}`)}</WorkBoardBadge></>}
      title={item.title}
      subtitle={item.slice_id ? `${item.slice_id} · ${item.owner_profile}` : item.owner_profile}
      footer={footer}
    >
      <WorkBoardSection title={t('workflow.outcome')}>
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{item.outcome}</p>
      </WorkBoardSection>

      <WorkBoardSection icon={CheckSquare} title={t('workflow.acceptance')} count={`${progress}/${item.acceptance.length}`}>
        {item.acceptance.length > 0 && <WorkBoardProgress value={progress} max={item.acceptance.length} tone={item.status === 'review' ? 'violet' : 'green'} />}
        <div className="mt-2 space-y-1">
          {item.acceptance.map((criterion, criterionIndex) => <div key={`${criterionIndex}:${criterion}`} className="flex items-start gap-2 rounded p-1.5 hover:bg-muted/40">{done ? <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded border border-muted-foreground/50" />}<span className={done ? 'text-sm text-muted-foreground line-through' : 'text-sm'}>{criterion}</span></div>)}
          {item.acceptance.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
        </div>
      </WorkBoardSection>

      <WorkBoardSection icon={Link2} title={t('workflow.dependencies')} count={item.depends_on.length}>
        <div className="space-y-1">
          {item.depends_on.map((dependencyId) => { const dependency = allItems.find((candidate) => candidate.id === dependencyId); const resolved = dependency?.status === 'done'; return <button type="button" key={dependencyId} onClick={() => onSelectItem(dependencyId)} className={`flex w-full items-center gap-2 rounded border p-2 text-left text-xs transition-colors hover:bg-muted/40 ${resolved ? 'border-emerald-500/20 text-emerald-400' : 'border-amber-500/20 text-amber-400'}`}><ArrowRight className="h-3.5 w-3.5" /><span className="font-mono">#{dependencyId}</span><span className="min-w-0 flex-1 truncate">{dependency?.title ?? dependencyId}</span><WorkBoardBadge tone={resolved ? 'green' : 'amber'}>{dependency?.status ?? 'missing'}</WorkBoardBadge></button>; })}
          {item.depends_on.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
        </div>
      </WorkBoardSection>

      <WorkBoardSection icon={Users} title={t('workflow.agentExecution')}>
        <div className="grid gap-2 sm:grid-cols-2"><div className="rounded border bg-muted/20 p-2"><p className="text-[9px] uppercase tracking-wide text-muted-foreground">{t('workflow.ownerProfile')}</p><p className="mt-1 text-sm font-medium">{item.owner_profile}</p></div><div className="rounded border bg-muted/20 p-2"><p className="text-[9px] uppercase tracking-wide text-muted-foreground">{t('workflow.execution')}</p><p className="mt-1 truncate text-sm font-medium">{item.run?.agent ?? item.run?.mode ?? t('workflow.awaitingDispatch')}</p>{item.run?.run_id && <p className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">{item.run.run_id}</p>}</div></div>
      </WorkBoardSection>

      <WorkBoardSection icon={ShieldCheck} title={t('workflow.evidence')} count={item.evidence.length}>
        <div className="space-y-1.5">{item.evidence.map((evidence, evidenceIndex) => <div key={`${evidence.kind}:${evidenceIndex}`} className="rounded border border-emerald-500/20 bg-emerald-500/5 p-2"><div className="flex items-center gap-2"><WorkBoardBadge tone="green">{evidence.kind}</WorkBoardBadge>{evidence.recorded_at && <span className="ml-auto text-[9px] text-muted-foreground">{new Date(evidence.recorded_at).toLocaleString()}</span>}</div><p className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground">{evidence.value}</p></div>)}{item.evidence.length === 0 && <p className="text-xs text-muted-foreground">{t('workflow.noEvidence')}</p>}</div>
      </WorkBoardSection>

      <WorkBoardSection icon={FileCode2} title={t('workflow.traceability')}>
        <div className="space-y-2 text-xs"><div><p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{t('workflow.sources')}</p><div className="flex flex-wrap gap-1">{item.source_ids.map((source) => <code key={source} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{source}</code>)}{item.source_ids.length === 0 && '—'}</div></div><div><p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{t('workflow.files')}</p><div className="space-y-0.5">{item.file_scope.map((file) => <p key={file} className="truncate font-mono text-[10px] text-muted-foreground">{file}</p>)}{item.file_scope.length === 0 && '—'}</div></div></div>
      </WorkBoardSection>

      {item.blocked_reason && <div className="mt-4 rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">{item.blocked_reason}</div>}

      {mutable && <div className="mt-5 flex items-center gap-2 border-t pt-3"><span className="text-xs text-muted-foreground">{t('workflow.columnOrder')}</span><Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy || index === 0} onClick={() => onAction('reorder', index - 1)}><ArrowUp className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy || index === count - 1} onClick={() => onAction('reorder', index + 1)}><ArrowDown className="h-3.5 w-3.5" /></Button></div>}

      {changing && <div className="mt-5 space-y-2 rounded border border-violet-500/20 bg-violet-500/5 p-3"><label className="text-xs font-semibold">{t('workflow.requestChanges')}</label><textarea className="min-h-24 w-full resize-y rounded border bg-background p-2 text-xs" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder={t('workflow.changePlaceholder')} /><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setChanging(false)}>{t('workflow.close')}</Button><Button size="sm" disabled={busy || !feedback.trim()} onClick={() => { onAction('request_changes', feedback.trim()); setChanging(false); setFeedback(''); }}>{t('workflow.sendChanges')}</Button></div></div>}
    </WorkBoardDetailDialog>
  );
}
