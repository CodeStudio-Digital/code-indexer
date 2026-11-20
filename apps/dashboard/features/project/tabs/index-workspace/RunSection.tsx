import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Database,
  Eye,
  Folder,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../../../components/ui/badge.js';
import { Button } from '../../../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../../components/ui/dialog.js';
import { confirm, toast } from '../../../../components/ui/prompt-dialog.js';
import { Progress } from '../../../../components/ui/progress.js';
import { useIndexStatus } from '../../../workspace/jetbrains/status-bar/useIndexStatus.js';
import { SemanticFolderPicker } from '../../settings/SemanticFolderPicker.js';
import {
  codeNamespaceStatus,
  semanticCoveragePercent,
  semanticWorkIsActive,
} from './project-semantic-api.js';
import { useProjectSemanticStatus } from './useProjectSemanticStatus.js';
import { SemanticSearchTestDialog } from './SemanticSearchTestDialog.js';

type Tone = 'muted' | 'info' | 'success' | 'warning' | 'destructive';

function bytes(value?: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function targetLabel(target?: { kind: string; model?: string; revision?: string; dtype?: string } | null): string {
  if (!target) return '—';
  if (target.kind === 'disabled') return 'Desativado';
  return [target.model ?? target.kind, target.revision, target.dtype].filter(Boolean).join(' · ');
}

function StatusBadge({ label, tone }: { label: string; tone: Tone }) {
  return <Badge variant={tone}>{label}</Badge>;
}

export function RunSection({
  projectId,
  projectName,
  onOpenFile,
}: {
  projectId: number;
  projectName: string;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useTranslation('projects');
  const [semanticTestOpen, setSemanticTestOpen] = useState(false);
  const [semanticFoldersOpen, setSemanticFoldersOpen] = useState(false);
  const structural = useIndexStatus(projectId);
  const semantic = useProjectSemanticStatus(projectId);
  const code = codeNamespaceStatus(semantic.status);
  const profile = semantic.status?.profiles.find((item) => item.purpose === 'code') ?? null;
  const job = semantic.status?.reindex_job ?? null;
  const semanticBusy = semanticWorkIsActive(semantic.status);
  const folders = semantic.status?.code_folders;
  const needsFolders = folders?.length === 0;

  const phase = structural?.phase as string | undefined;
  const structuralState = phase === 'error'
    ? { label: 'Erro', tone: 'destructive' as const }
    : phase === 'scanning' || phase === 'structural_indexing'
      ? { label: structural?.lastStructuralAt ? 'Reconciliando' : 'Construindo', tone: 'info' as const }
      : structural?.scheduledRun
        ? { label: 'Reconciliação agendada', tone: 'info' as const }
        : structural?.lastStructuralAt
          ? { label: 'Pronto', tone: 'success' as const }
          : { label: 'Ausente', tone: 'warning' as const };

  const watcherState = structural?.watcherMode === 'polling'
    ? { label: 'Verificação periódica', tone: 'info' as const }
    : structural?.watcherActive
    ? { label: 'Pronto', tone: 'success' as const }
    : phase === 'scanning' || phase === 'structural_indexing'
      ? { label: 'Iniciando', tone: 'info' as const }
      : { label: 'Desligado', tone: 'muted' as const };

  const semanticDisabled = profile?.embedding_target.kind === 'disabled';
  const semanticState = semanticDisabled
    ? { label: 'Desativado', tone: 'muted' as const }
    : semantic.error || code?.last_error || job?.status === 'failed'
      ? { label: 'Erro', tone: 'destructive' as const }
      : job?.status === 'paused'
        ? { label: 'Pausado', tone: 'warning' as const }
        : job?.status === 'pending'
          ? { label: 'Na fila', tone: 'info' as const }
          : semanticBusy || code?.building
            ? { label: code?.active ? 'Atualizando' : 'Construindo', tone: 'info' as const }
            : code?.active && (code.delta_items ?? 0) > 0
              ? { label: 'Desatualizado', tone: 'warning' as const }
              : code?.active
                ? { label: 'Ativo', tone: 'success' as const }
                : { label: 'Aguardando', tone: 'warning' as const };

  const localAutomatic = profile?.embedding_target.kind === 'onnx'
    || profile?.embedding_target.kind === 'local_http';
  const remoteInference = profile?.embedding_target.kind === 'provider'
    || profile?.reranker_target?.kind === 'provider';
  const activeTarget = semantic.status?.active_generation?.embedding_target;
  const buildingTarget = semantic.status?.building_generation?.embedding_target;
  const resolvedReranker = semantic.status?.resolved_reranker;
  const searchTelemetry = semantic.status?.search_telemetry;
  const rerankerLabel = !resolvedReranker || resolvedReranker.status === 'disabled'
    ? 'Desativado'
    : [
        resolvedReranker.status === 'failed'
          ? 'Falhou'
          : resolvedReranker.status === 'running'
            ? 'Executando'
            : resolvedReranker.status === 'active'
              ? 'Ativo'
              : 'Configurado',
        resolvedReranker.model,
        resolvedReranker.dtype,
        resolvedReranker.execution_provider,
      ].filter(Boolean).join(' · ');
  const coverage = semanticCoveragePercent(code);
  const fatalError = semantic.error
    ?? code?.last_error
    ?? (job?.status === 'failed' ? job.error : null)
    ?? structural?.error
    ?? null;
  const pauseNotice = job?.status === 'paused' ? job.error : null;

  const activities = [
    structural?.activeRun
      ? `Estrutural: ${structural.activeRun.current}/${structural.activeRun.total}${structural.activeRun.currentFile ? ` · ${structural.activeRun.currentFile}` : ''}`
      : null,
    structural?.scheduledRun
      ? `Reconciliação estrutural agendada (${structural.scheduledRun.reason})`
      : null,
    job && ['pending', 'running', 'paused'].includes(job.status)
      ? `Semântico: ${job.status} · ${job.processed_items}/${job.expected_items}${job.failed_items ? ` · ${job.failed_items} falhas` : ''}`
      : null,
  ].filter((item): item is string => !!item);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="border-muted">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-sky-400" />
                <CardTitle className="text-sm">{t('index.overview.structuralTitle')}</CardTitle>
              </div>
              <StatusBadge label={structuralState.label} tone={structuralState.tone} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <p className="text-muted-foreground">{t('index.overview.structuralDescription')}</p>
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Arquivos" value={structural?.fileCount ?? 0} />
              <Metric label="Símbolos" value={structural?.symbolCount ?? 0} />
            </div>
            <Detail label="Último baseline" value={structural?.lastStructuralAt ?? 'Ainda não criado'} />
            <Detail label="Última verificação" value={structural?.lastCheckedAt ?? 'Ainda não verificado'} />
            <Detail label="Deltas pendentes" value={String(structural?.dirtyPending ?? 0)} />
          </CardContent>
        </Card>

        <Card className="border-muted">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-emerald-400" />
                <CardTitle className="text-sm">{t('index.overview.watcherTitle')}</CardTitle>
              </div>
              <StatusBadge label={watcherState.label} tone={watcherState.tone} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <p className="text-muted-foreground">{t('index.overview.watcherDescription')}</p>
            <Detail label="Estado observado" value={structural?.watcherMode === 'polling'
              ? 'Arquivos abertos acompanhados; projeto reconciliado periodicamente'
              : structural?.watcherActive ? 'Monitorando o projeto' : 'Sem lease ativo'} />
            <Detail label="Fila atual" value={`${structural?.dirtyPending ?? 0} alteração(ões)`} />
          </CardContent>
        </Card>

        <Card className="border-muted xl:row-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-violet-400" />
                <CardTitle className="text-sm">{t('index.overview.semanticTitle')}</CardTitle>
              </div>
              <StatusBadge label={semanticState.label} tone={semanticState.tone} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-xs">
            {semantic.loading && !semantic.status ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('index.overview.loading')}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t('index.overview.coverage')}</span>
                    <span className="tabular-nums">{code?.indexed_items ?? 0}/{code?.expected_items ?? 0} · {coverage}%</span>
                  </div>
                  <Progress value={coverage} indeterminate={semanticBusy && !(code?.expected_items ?? 0)} />
                </div>
                <Detail label="Perfil configurado" value={targetLabel(profile?.embedding_target)} />
                <Detail
                  label="Geração ativa"
                  value={code?.active
                    ? `g${code.active.generationId} · ${activeTarget ? targetLabel(activeTarget) : 'target não exposto'}`
                    : '—'}
                />
                <Detail
                  label="Em construção"
                  value={code?.building
                    ? `g${code.building.generationId} · ${buildingTarget ? targetLabel(buildingTarget) : 'target não exposto'}`
                    : '—'}
                />
                <Detail label="Banco físico" value={code?.dbPath ?? code?.active?.dbPath ?? code?.building?.dbPath ?? '—'} mono />
                <Detail label="Uso em disco" value={bytes(code?.size_bytes)} />
                {searchTelemetry ? (
                  <>
                    <Detail
                      label={`Buscas (${searchTelemetry.period_days} dias)`}
                      value={`${searchTelemetry.total_searches} total · ${searchTelemetry.semantic_searches} semânticas`}
                    />
                    <Detail
                      label="Reranker aplicado"
                      value={`${searchTelemetry.reranker_applied} · ${searchTelemetry.reranker_failed} falha(s)`}
                    />
                    <Detail
                      label="Resultados abertos na interface"
                      value={`${searchTelemetry.opened_results} · ${searchTelemetry.semantic_wins} ganho(s) semântico(s)`}
                    />
                    <Detail
                      label="Latência p50 / p95"
                      value={searchTelemetry.p50_ms == null
                        ? 'Ainda não medida'
                        : `${searchTelemetry.p50_ms.toFixed(0)} / ${(searchTelemetry.p95_ms ?? searchTelemetry.p50_ms).toFixed(0)} ms`}
                    />
                  </>
                ) : null}
                <Detail
                  label="Reranker"
                  value={rerankerLabel}
                />
                {resolvedReranker?.estimated_memory_bytes ? (
                  <Detail label="Memória estimada" value={bytes(resolvedReranker.estimated_memory_bytes)} />
                ) : null}
                {resolvedReranker?.last_latency_ms != null ? (
                  <Detail label="Última latência" value={`${resolvedReranker.last_latency_ms.toFixed(0)} ms`} />
                ) : null}
                {resolvedReranker?.downgrade_reason ? (
                  <p className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-amber-500">{resolvedReranker.downgrade_reason}</p>
                ) : null}
                {resolvedReranker?.last_error ? (
                  <p className="rounded-md border border-destructive/20 bg-destructive/5 p-2 text-destructive">{resolvedReranker.last_error}</p>
                ) : null}
                <p className="rounded-md border bg-muted/20 p-2 text-muted-foreground">
                  {semanticDisabled
                    ? 'Embedding desativado neste perfil.'
                    : needsFolders
                      ? t('edit.semanticFoldersRequired')
                    : localAutomatic
                      ? 'Target local: o primeiro backfill deste projeto pode iniciar automaticamente após o estrutural.'
                      : 'Target remoto: a primeira geração exige confirmação; abrir o projeto não faz chamadas automáticas.'}
                </p>
                {fatalError ? (
                  <div className="flex gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-2 text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" /> {fatalError}
                  </div>
                ) : pauseNotice ? (
                  <div className="flex gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 p-2 text-amber-500">
                    <AlertCircle className="h-4 w-4 shrink-0" /> {pauseNotice}
                  </div>
                ) : code?.active && !semanticBusy ? (
                  <div className="flex gap-2 text-emerald-500">
                    <CheckCircle2 className="h-4 w-4 shrink-0" /> {t('index.overview.activeServing')}
                  </div>
                ) : null}
                {semantic.cleanupResult ? (
                  <div className={semantic.cleanupResult.failures.length > 0
                    ? 'rounded-md border border-amber-500/20 bg-amber-500/10 p-2 text-amber-500'
                    : 'rounded-md border border-emerald-500/20 bg-emerald-500/10 p-2 text-emerald-500'}>
                    {t('index.overview.cleanupResult', {
                      tables: semantic.cleanupResult.tables_removed,
                      bytes: bytes(semantic.cleanupResult.bytes_reclaimed),
                    })}
                    {semantic.cleanupResult.failures.length > 0
                      ? ` · ${t('index.overview.cleanupPartial', { count: semantic.cleanupResult.failures.length })}`
                      : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
                  {folders && !needsFolders && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setSemanticFoldersOpen(true)}>
                      <Folder className="h-4 w-4" /> {t('edit.semanticFoldersTitle')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void semantic.refresh()}
                    disabled={semantic.requesting || semantic.cleaning}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" /> {t('index.overview.refresh')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSemanticTestOpen(true)}
                    disabled={semantic.loading && !semantic.status}
                  >
                    <Search className="mr-2 h-4 w-4" /> {t('index.overview.testSearch')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const accepted = await confirm({
                        title: t('index.overview.cleanupConfirmTitle'),
                        description: t('index.overview.cleanupConfirm'),
                        confirmLabel: t('index.overview.cleanupUnused'),
                        tone: 'destructive',
                      });
                      if (!accepted) return;
                      try {
                        const result = await semantic.cleanupUnused();
                        const description = t('index.overview.cleanupResult', {
                          tables: result.tables_removed,
                          bytes: bytes(result.bytes_reclaimed),
                        });
                        if (result.failures.length > 0) {
                          toast.warning(t('index.overview.cleanupPartialTitle'), {
                            description: `${description} · ${t('index.overview.cleanupPartial', {
                              count: result.failures.length,
                            })}`,
                          });
                        } else {
                          toast.success(t('index.overview.cleanupSuccessTitle'), { description });
                        }
                      } catch (error) {
                        toast.error(t('index.overview.cleanupErrorTitle'), {
                          description: error instanceof Error ? error.message : String(error),
                        });
                      }
                    }}
                    disabled={semanticBusy || semantic.requesting || semantic.cleaning}
                  >
                    {semantic.cleaning
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : <Trash2 className="mr-2 h-4 w-4" />}
                    {t('index.overview.cleanupUnused')}
                  </Button>
                  <Button type="button" size="sm" onClick={() => {
                    if (needsFolders) setSemanticFoldersOpen(true);
                    else void semantic.reindex();
                  }} disabled={semanticDisabled || semanticBusy || semantic.requesting || semantic.cleaning}>
                    {semantic.requesting || semanticBusy
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : <Play className="mr-2 h-4 w-4" />}
                    {needsFolders
                      ? t('edit.semanticChooseFolders')
                      : job?.status === 'paused'
                      ? 'Retomar este projeto'
                      : code?.active
                        ? 'Reconstruir este projeto'
                        : 'Indexar este projeto'}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="border-muted xl:col-span-2">
          <CardHeader className="pb-3"><CardTitle className="text-sm">{t('index.overview.activitiesTitle')}</CardTitle></CardHeader>
          <CardContent className="text-xs">
            {activities.length ? (
              <ul className="space-y-2">
                {activities.map((activity) => <li key={activity} className="rounded-md border bg-muted/20 px-3 py-2">{activity}</li>)}
              </ul>
            ) : (
              <p className="text-muted-foreground">{t('index.overview.activitiesEmpty')}</p>
            )}
          </CardContent>
        </Card>
      </div>
      <Dialog open={semanticFoldersOpen} onOpenChange={setSemanticFoldersOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('edit.semanticFoldersTitle')}</DialogTitle>
          </DialogHeader>
          <SemanticFolderPicker projectId={projectId} onSaved={() => {
            setSemanticFoldersOpen(false);
            void semantic.refresh();
          }} />
        </DialogContent>
      </Dialog>
      <SemanticSearchTestDialog
        projectId={projectId}
        projectName={projectName}
        open={semanticTestOpen}
        onOpenChange={setSemanticTestOpen}
        remoteInference={remoteInference}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 border-b border-border/50 pb-2 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-all text-right ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  );
}
