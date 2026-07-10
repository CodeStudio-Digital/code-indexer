import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  GitBranch,
  History,
  Layers3,
  Loader2,
  Plus,
  RefreshCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { cn } from '../../../lib/utils.js';
import type {
  AppEvolutionView,
  AppSpecHistoryView,
  AppSpecImpactView,
  AppSpecRevisionView,
  AppStudioSessionDetail,
} from '../app-studio-api.js';
import {
  applyAppEvolution,
  createAppEvolution,
  deleteAppEvolution,
  getAppSpecHistory,
  rejectAppEvolution,
} from '../app-studio-api.js';

interface VersionsPanelProps {
  detail: AppStudioSessionDetail;
  onChanged: () => void;
  onOpenSpecAgent?: (prompt: string) => void;
}

const IMPACT_CLASS: Record<AppSpecImpactView['level'], string> = {
  none: 'border-muted bg-muted/30 text-muted-foreground',
  low: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-400/30 dark:bg-sky-950/25 dark:text-sky-200',
  medium:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-950/25 dark:text-amber-200',
  high: 'border-red-300 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-950/25 dark:text-red-200',
};

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function buildEvolutionPrompt(detail: AppStudioSessionDetail, evolution: AppEvolutionView): string {
  return [
    'Abra uma evolucao versionada do plano deste App Studio.',
    `App: ${detail.session.name}`,
    `Evolution id: ${evolution.id}`,
    `Titulo: ${evolution.title}`,
    evolution.description ? `Descricao: ${evolution.description}` : null,
    '',
    'Comece com app_get_pipeline, app_get_spec e app_spec_audit.',
    'Faça perguntas uma por vez se faltar decisao do usuario.',
    'Quando o refinamento estiver pronto, chame app_propose_spec_revision com evolution_id informado e a spec completa.',
    'Nao use app_save_spec se discovery ja estiver aprovada; esta mudanca precisa ficar reviewable em Versoes.',
  ].filter(Boolean).join('\n');
}

function stageNames(impact: AppSpecImpactView | null, t: (key: string) => string): string {
  if (!impact || impact.stage_ids.length === 0) return t('versions.impact.none');
  return impact.stage_ids.map((id) => t(`stages.${id}.name`)).join(' -> ');
}

function ImpactBadge({ impact }: { impact: AppSpecImpactView | null }) {
  const { t } = useTranslation('appStudio');
  const level = impact?.level ?? 'none';
  return (
    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold', IMPACT_CLASS[level])}>
      {t(`versions.impact.${level}`)}
    </span>
  );
}

function StatusBadge({ status }: { status: AppEvolutionView['status'] | AppSpecRevisionView['status'] }) {
  const { t } = useTranslation('appStudio');
  const cls =
    status === 'approved' || status === 'applied'
      ? 'border-green-300 bg-green-50 text-green-700 dark:border-green-400/30 dark:bg-green-950/25 dark:text-green-200'
      : status === 'review' || status === 'draft'
        ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-950/25 dark:text-amber-200'
        : status === 'superseded'
          ? 'border-muted bg-muted/30 text-muted-foreground'
          : 'border-red-300 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-950/25 dark:text-red-200';
  return (
    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold', cls)}>
      {t(`versions.status.${status}`)}
    </span>
  );
}

export function VersionsPanel({ detail, onChanged, onOpenSpecAgent }: VersionsPanelProps) {
  const { t } = useTranslation('appStudio');
  const [history, setHistory] = useState<AppSpecHistoryView | null>(null);
  const [selectedEvolutionId, setSelectedEvolutionId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [mutatingId, setMutatingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const next = await getAppSpecHistory(detail.session.id);
      setHistory(next);
      setSelectedEvolutionId((current) => {
        if (current && next.evolutions.some((e) => e.id === current)) return current;
        return next.evolutions.find((e) => e.status === 'review')?.id ?? next.evolutions[0]?.id ?? null;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.session.id]);

  const selectedEvolution = useMemo(
    () => history?.evolutions.find((e) => e.id === selectedEvolutionId) ?? null,
    [history, selectedEvolutionId],
  );
  const proposedRevision = useMemo(
    () => history?.revisions.find((r) => r.id === selectedEvolution?.proposed_revision_id) ?? null,
    [history, selectedEvolution],
  );
  const currentRevision = useMemo(
    () => history?.revisions.find((r) => r.id === history.current_revision_id) ?? null,
    [history],
  );
  const openChanges = history?.evolutions.filter((e) => e.status === 'draft' || e.status === 'review').length ?? 0;

  async function handleCreate() {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createAppEvolution(detail.session.id, {
        title: cleanTitle,
        description: description.trim() || null,
      });
      setTitle('');
      setDescription('');
      await refresh();
      setSelectedEvolutionId(created.evolution.id);
      onOpenSpecAgent?.(buildEvolutionPrompt(detail, created.evolution));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleApply(evolution: AppEvolutionView) {
    const go = await confirm({
      title: t('versions.applyTitle'),
      description: t('versions.applyBody'),
      confirmLabel: t('versions.applyConfirm'),
    });
    if (!go) return;
    setMutatingId(evolution.id);
    setError(null);
    try {
      await applyAppEvolution(detail.session.id, evolution.id);
      await refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMutatingId(null);
    }
  }

  async function handleReject(evolution: AppEvolutionView) {
    setMutatingId(evolution.id);
    setError(null);
    try {
      await rejectAppEvolution(detail.session.id, evolution.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMutatingId(null);
    }
  }

  // Discard an EMPTY draft evolution (no proposed revision) — junk left by a
  // looping agent or a "Criar" that never got refined. Guarded on the server
  // to draft-only, so this can't nuke real history.
  async function handleDiscard(evolution: AppEvolutionView) {
    const go = await confirm({
      title: t('versions.discardTitle'),
      description: t('versions.discardBody'),
      confirmLabel: t('versions.discard'),
    });
    if (!go) return;
    setMutatingId(evolution.id);
    setError(null);
    try {
      await deleteAppEvolution(detail.session.id, evolution.id);
      if (selectedEvolutionId === evolution.id) setSelectedEvolutionId(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMutatingId(null);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <GitBranch className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{t('versions.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('versions.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="mr-1 h-3.5 w-3.5" />}
          {t('versions.refresh')}
        </Button>
      </header>

      {error && (
        <div className="mx-4 mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-400/30 dark:bg-red-950/25 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r bg-card/35">
          <div className="grid grid-cols-2 gap-2 border-b p-3">
            <div className="rounded-md border bg-background p-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <History className="h-3.5 w-3.5" />
                {t('versions.current')}
              </div>
              <div className="mt-1 text-lg font-semibold">
                {currentRevision ? `v${currentRevision.revision_number}` : '-'}
              </div>
            </div>
            <div className="rounded-md border bg-background p-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Layers3 className="h-3.5 w-3.5" />
                {t('versions.openChanges')}
              </div>
              <div className="mt-1 text-lg font-semibold">{openChanges}</div>
            </div>
          </div>

          <div className="space-y-2 border-b p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">{t('versions.newChange')}</p>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('versions.titlePlaceholder')}
              className="h-8"
            />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('versions.descriptionPlaceholder')}
              className="min-h-[72px] text-xs"
            />
            <Button className="w-full justify-center gap-2" size="sm" disabled={!title.trim() || creating} onClick={() => void handleCreate()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t('versions.createWithAgent')}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <p className="px-1 pb-2 text-xs font-semibold uppercase text-muted-foreground">{t('versions.changes')}</p>
            {history?.evolutions.length ? (
              <div className="space-y-1.5">
                {history.evolutions.map((evolution) => (
                  <button
                    key={evolution.id}
                    type="button"
                    onClick={() => setSelectedEvolutionId(evolution.id)}
                    className={cn(
                      'w-full rounded-md border p-2 text-left transition-colors hover:bg-muted/60',
                      selectedEvolutionId === evolution.id ? 'border-primary bg-primary/5' : 'bg-background',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold">{evolution.title}</span>
                      <StatusBadge status={evolution.status} />
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate">{formatDate(evolution.created_at)}</span>
                      <ImpactBadge impact={evolution.impact} />
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed bg-background p-3 text-xs text-muted-foreground">
                {t('versions.noChanges')}
              </div>
            )}
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto p-4">
          {!history && loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('versions.loading')}
            </div>
          ) : selectedEvolution ? (
            <div className="mx-auto max-w-5xl space-y-4">
              <section className="rounded-md border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">{selectedEvolution.title}</h3>
                      <StatusBadge status={selectedEvolution.status} />
                      <ImpactBadge impact={selectedEvolution.impact} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {selectedEvolution.description || t('versions.noDescription')}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => onOpenSpecAgent?.(buildEvolutionPrompt(detail, selectedEvolution))}
                    >
                      <Bot className="h-4 w-4" />
                      {t('versions.openAgent')}
                    </Button>
                    {selectedEvolution.status === 'draft' && !selectedEvolution.proposed_revision_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-2 text-muted-foreground hover:text-red-600"
                        disabled={mutatingId === selectedEvolution.id}
                        onClick={() => void handleDiscard(selectedEvolution)}
                      >
                        {mutatingId === selectedEvolution.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        {t('versions.discard')}
                      </Button>
                    )}
                    {selectedEvolution.status === 'review' && (
                      <>
                        <Button
                          size="sm"
                          className="gap-2"
                          disabled={mutatingId === selectedEvolution.id}
                          onClick={() => void handleApply(selectedEvolution)}
                        >
                          {mutatingId === selectedEvolution.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                          {t('versions.apply')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-2"
                          disabled={mutatingId === selectedEvolution.id}
                          onClick={() => void handleReject(selectedEvolution)}
                        >
                          <XCircle className="h-4 w-4" />
                          {t('versions.reject')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </section>

              <section className="grid gap-3 lg:grid-cols-[1fr_280px]">
                <div className="rounded-md border bg-card p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <h4 className="text-sm font-semibold">{t('versions.impactTitle')}</h4>
                  </div>
                  <div className="space-y-3">
                    <div className="rounded-md border bg-background p-3">
                      <p className="text-xs font-semibold uppercase text-muted-foreground">{t('versions.affectedStages')}</p>
                      <p className="mt-1 text-sm">{stageNames(selectedEvolution.impact, t)}</p>
                    </div>
                    {selectedEvolution.impact?.reasons.length ? (
                      <div className="space-y-2">
                        {selectedEvolution.impact.reasons.map((reason) => (
                          <p key={reason} className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
                            {reason}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="rounded-md border border-dashed bg-background px-3 py-2 text-sm text-muted-foreground">
                        {t('versions.noImpactYet')}
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-md border bg-card p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Clock3 className="h-4 w-4 text-primary" />
                    <h4 className="text-sm font-semibold">{t('versions.timeline')}</h4>
                  </div>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">{t('versions.createdAt')}</p>
                      <p>{formatDate(selectedEvolution.created_at)}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">{t('versions.submittedAt')}</p>
                      <p>{formatDate(selectedEvolution.submitted_at)}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">{t('versions.appliedAt')}</p>
                      <p>{formatDate(selectedEvolution.applied_at)}</p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-md border bg-card p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">{t('versions.proposedRevision')}</h4>
                  {proposedRevision && <StatusBadge status={proposedRevision.status} />}
                </div>
                {proposedRevision ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <RevisionMetric label={t('versions.version')} value={`v${proposedRevision.revision_number}`} />
                    <RevisionMetric label={t('versions.screens')} value={String(proposedRevision.spec_summary?.screens ?? '-')} />
                    <RevisionMetric label={t('versions.dataEntities')} value={String(proposedRevision.spec_summary?.entities ?? '-')} />
                    <RevisionMetric label={t('versions.actions')} value={String(proposedRevision.spec_summary?.behaviors ?? '-')} />
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed bg-background p-3 text-sm text-muted-foreground">
                    {t('versions.noProposal')}
                  </div>
                )}
              </section>

              <section className="rounded-md border bg-card p-4">
                <h4 className="mb-3 text-sm font-semibold">{t('versions.history')}</h4>
                <div className="space-y-2">
                  {(history?.revisions ?? []).map((revision) => (
                    <div key={revision.id} className="flex flex-wrap items-center gap-3 rounded-md border bg-background px-3 py-2">
                      <span className="font-mono text-xs">v{revision.revision_number}</span>
                      <StatusBadge status={revision.status} />
                      <span className="min-w-0 flex-1 truncate text-sm">{revision.title || revision.spec_summary?.summary || '-'}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(revision.created_at)}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-md rounded-md border border-dashed bg-card p-6 text-center">
                <GitBranch className="mx-auto h-8 w-8 text-primary" />
                <h3 className="mt-3 text-sm font-semibold">{t('versions.emptyTitle')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t('versions.emptyBody')}</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}

function RevisionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
