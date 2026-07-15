import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle, Check, Loader2, RefreshCcw, Search, Sparkles, Workflow,
} from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { WorkBoardBadge, WorkBoardColumn, WorkBoardToolbar, WorkBoardViewport } from '../../../components/work-board/index.js';
import { AppWorkItemCard } from './AppWorkItemCard.js';
import { AppWorkItemDialog } from './AppWorkItemDialog.js';
import {
  resolveAppApproval,
  resolveAppDecision,
  updateAppWorkItem,
  type AppApprovalView,
  type AppStudioSessionDetail,
  type AppWorkItemStatus,
  type AppWorkItemView,
  type AppWorkflowPhaseId,
} from '../app-studio-api.js';

const COLUMNS: Array<{ status: AppWorkItemStatus; key: string }> = [
  { status: 'backlog', key: 'backlog' },
  { status: 'ready', key: 'ready' },
  { status: 'running', key: 'running' },
  { status: 'review', key: 'review' },
  { status: 'done', key: 'done' },
];

const PHASES: AppWorkflowPhaseId[] = ['define', 'blueprint', 'build', 'deliver'];

const COLUMN_ACCENT: Record<(typeof COLUMNS)[number]['status'], string> = {
  backlog: 'border-t-muted-foreground/40',
  ready: 'border-t-blue-500',
  running: 'border-t-yellow-500',
  review: 'border-t-purple-500',
  done: 'border-t-green-500',
};

function ApprovalCard({ approval, busy, onResolve }: { approval: AppApprovalView; busy: boolean; onResolve: (approval: AppApprovalView, decision: 'approve' | 'request_changes', feedback?: string) => void }) {
  const { t } = useTranslation('appStudio');
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState('');
  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">{t(`workflow.approvals.${approval.type}`)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{approval.summary}</p>
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => onResolve(approval, 'approve')}><Check className="mr-1 h-3 w-3" />{t('workflow.approve')}</Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => setChanging((value) => !value)}>{t('workflow.requestChanges')}</Button>
      </div>
      {changing && (
        <div className="mt-2 space-y-1.5">
          <textarea className="min-h-16 w-full resize-y rounded border bg-background p-2 text-xs" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder={t('workflow.changePlaceholder')} />
          <Button size="sm" className="h-7 text-xs" disabled={busy || !feedback.trim()} onClick={() => onResolve(approval, 'request_changes', feedback)}>{t('workflow.sendChanges')}</Button>
        </div>
      )}
    </div>
  );
}

function DecisionCard({
  decision,
  busy,
  onResolve,
}: {
  decision: AppStudioSessionDetail['workflow']['decisions'][number];
  busy: boolean;
  onResolve: (answer: string) => void;
}) {
  const { t } = useTranslation('appStudio');
  const [answer, setAnswer] = useState('');
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-xs font-semibold">{decision.question}</p>
      {decision.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {decision.options.map((option) => (
            <Button key={option.value} variant="outline" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => onResolve(option.value)}>
              {option.label}
            </Button>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <input
          className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-xs"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && answer.trim() && !busy) onResolve(answer.trim());
          }}
          placeholder={t('workflow.answerPlaceholder')}
        />
        <Button size="sm" className="h-8 text-xs" disabled={busy || !answer.trim()} onClick={() => onResolve(answer.trim())}>
          {t('workflow.answerDecision')}
        </Button>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">{t('workflow.blocksCards', { count: decision.blocked_work_item_ids.length })}</p>
    </div>
  );
}

export function JourneyPanel({ detail, onChanged }: { detail: AppStudioSessionDetail; onChanged: () => void }) {
  const { t } = useTranslation('appStudio');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortByPriority, setSortByPriority] = useState(false);
  const [exceptionFilter, setExceptionFilter] = useState<'all' | 'blocked' | 'stale'>('all');
  const workflow = detail.workflow;
  const pendingApprovals = workflow.approvals.filter((approval) => approval.status === 'pending');
  const openDecisions = workflow.decisions.filter((decision) => decision.status === 'open');
  const blockedCount = workflow.work_items.filter((item) => item.status === 'blocked').length;
  const staleCount = workflow.work_items.filter((item) => item.status === 'stale').length;
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (item: AppWorkItemView) => !normalizedQuery || `${item.title} ${item.outcome} ${item.owner_profile} ${item.kind} ${item.slice_id ?? ''}`.toLowerCase().includes(normalizedQuery);
  const sortItems = (items: AppWorkItemView[]) => [...items].sort((a, b) => sortByPriority ? b.priority - a.priority || a.sort_order - b.sort_order : a.sort_order - b.sort_order || b.priority - a.priority);

  const board = useMemo(() => COLUMNS.map((column) => ({
    ...column,
    items: sortItems(workflow.work_items.filter((item) => item.status === column.status && matchesQuery(item))),
  })), [workflow.work_items, normalizedQuery, sortByPriority]);
  const exceptionalItems = sortItems(workflow.work_items.filter((item) => item.status === exceptionFilter && matchesQuery(item)));
  const selectedItem = selectedId ? workflow.work_items.find((item) => item.id === selectedId) ?? null : null;
  const selectedColumnItems = selectedItem ? sortItems(workflow.work_items.filter((item) => item.status === selectedItem.status)) : [];
  const selectedIndex = selectedItem ? selectedColumnItems.findIndex((item) => item.id === selectedItem.id) : -1;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function actOn(item: AppWorkItemView, action: 'reorder' | 'pause' | 'resume' | 'cancel' | 'request_changes', value?: string | number) {
    void run(() => updateAppWorkItem(detail.session.id, item.id, {
      action,
      ...(typeof value === 'number' ? { sort_order: value } : typeof value === 'string' ? { feedback: value } : {}),
    }));
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b bg-[var(--workbench-raised)] px-3 py-1.5">
        <Workflow className="h-4 w-4 text-primary" />
        <div className="mr-2 min-w-0"><h2 className="truncate text-sm font-semibold">{t('workflow.kanban')}</h2><p className="truncate text-[9px] text-muted-foreground">{t('workflow.reviewAutomated')}</p></div>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {PHASES.map((phaseId, index) => {
          const phase = workflow.state.phases.find((candidate) => candidate.id === phaseId)!;
          return (
            <div key={phaseId} className={`flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-[10px] ${phase.status === 'complete' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : phase.status === 'attention' ? 'border-violet-500/40 bg-violet-500/10 text-violet-400' : phase.status === 'active' ? 'border-blue-500/30 bg-blue-500/10 text-blue-400' : 'bg-muted/30 text-muted-foreground'}`}><span className="font-mono">{index + 1}</span><span className="font-medium">{t(`workflow.phases.${phaseId}`)}</span><span className="hidden opacity-70 xl:inline">· {t(`workflow.phaseStatus.${phase.status}`)}</span></div>
          );
        })}
        </div>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </header>

      {(pendingApprovals.length > 0 || openDecisions.length > 0) && (
        <section className="max-h-48 shrink-0 overflow-y-auto border-b border-violet-500/20 bg-violet-500/[0.03] p-2.5">
          <div className="mb-2 flex items-center gap-2"><AlertCircle className="h-3.5 w-3.5 text-violet-400" /><h3 className="text-xs font-semibold">{t('workflow.attention')}</h3><WorkBoardBadge tone="violet">{pendingApprovals.length + openDecisions.length}</WorkBoardBadge></div>
          <div className="grid gap-2 xl:grid-cols-2">
            {pendingApprovals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} busy={busy} onResolve={(candidate, decision, feedback) => void run(() => resolveAppApproval(detail.session.id, candidate.id, decision, { feedback }))} />
            ))}
            {openDecisions.map((decision) => (
              <DecisionCard key={decision.id} decision={decision} busy={busy} onResolve={(answer) => void run(() => resolveAppDecision(detail.session.id, decision.id, answer))} />
            ))}
          </div>
        </section>
      )}

      {error && <p className="mx-3 mt-2 shrink-0 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-400">{error}</p>}

      <WorkBoardToolbar>
        <Button size="sm" variant={sortByPriority ? 'default' : 'outline'} className="h-7" onClick={() => setSortByPriority((value) => !value)}><Sparkles className="mr-1 h-3 w-3" />{sortByPriority ? t('workflow.prioritiesActive') : t('workflow.sortPriorities')}</Button>
        <WorkBoardBadge tone="green">{t('workflow.multiAgentAuto')}</WorkBoardBadge>
        <span className="hidden text-muted-foreground lg:inline">{t('workflow.cardProgress', { total: workflow.work_items.length, complete: workflow.work_items.filter((item) => item.status === 'done').length })}</span>
        <div className="ml-auto flex items-center gap-1">
          {blockedCount > 0 && <Button size="sm" variant={exceptionFilter === 'blocked' ? 'destructive' : 'ghost'} className="h-7 px-2" onClick={() => setExceptionFilter((value) => value === 'blocked' ? 'all' : 'blocked')}>{t('workflow.blocked')} {blockedCount}</Button>}
          {staleCount > 0 && <Button size="sm" variant={exceptionFilter === 'stale' ? 'secondary' : 'ghost'} className="h-7 px-2" onClick={() => setExceptionFilter((value) => value === 'stale' ? 'all' : 'stale')}>{t('workflow.stale')} {staleCount}</Button>}
          <label className="relative hidden sm:block"><Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="h-7 w-44 rounded border bg-background pl-7 pr-2 text-[11px]" placeholder={t('workflow.filterCards')} /></label>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onChanged} aria-label={t('workflow.refreshKanban')}><RefreshCcw className="h-3.5 w-3.5" /></Button>
        </div>
      </WorkBoardToolbar>

      <div className="min-h-0 flex-1">
        <WorkBoardViewport className="h-full p-2">
          {exceptionFilter === 'all' ? (
            <>{board.map((column) => (
              <WorkBoardColumn
                key={column.status}
                title={t(`workflow.columns.${column.key}`)}
                count={column.items.length}
                accentClass={COLUMN_ACCENT[column.status]}
                emptyLabel={t('workflow.noCards')}
              >
                {column.items.map((item) => <AppWorkItemCard key={item.id} item={item} onOpen={() => setSelectedId(item.id)} />)}
              </WorkBoardColumn>
            ))}</>
          ) : (
            <WorkBoardColumn title={exceptionFilter === 'blocked' ? t('workflow.blocked') : t('workflow.stale')} count={exceptionalItems.length} accentClass={exceptionFilter === 'blocked' ? 'border-t-red-500' : 'border-t-amber-500'} emptyLabel={t('workflow.noCards')} className="max-w-[420px]">
              {exceptionalItems.map((item) => <AppWorkItemCard key={item.id} item={item} onOpen={() => setSelectedId(item.id)} />)}
            </WorkBoardColumn>
          )}
        </WorkBoardViewport>
      </div>

      {selectedItem && <AppWorkItemDialog item={selectedItem} allItems={workflow.work_items} index={Math.max(0, selectedIndex)} count={selectedColumnItems.length} busy={busy} onClose={() => setSelectedId(null)} onSelectItem={setSelectedId} onAction={(action, value) => actOn(selectedItem, action, value)} />}
    </div>
  );
}
