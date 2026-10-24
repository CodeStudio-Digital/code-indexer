import { type SemanticGenerationView, type SemanticJobView, type SemanticRerankerStatusView, type SemanticProfileView } from './semantic-api.js';
import type { AdminProvider } from './types.js';
import { useTranslation } from 'react-i18next';
import { AlertCircle, BookOpen, Code2, HardDrive, Loader2, Pencil, RotateCcw, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Badge } from '../../components/ui/badge.js';
import { Progress } from '../../components/ui/progress.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { generationProgress, isExecutingSemanticJob, generationVariant, targetModel, targetSource, formatBytes } from './semantic-indexing-format.js';

interface ProfileCardProps {
  profile: SemanticProfileView;
  generation: SemanticGenerationView | null;
  job: SemanticJobView | null;
  rerankerStatus: SemanticRerankerStatusView;
  providers: AdminProvider[];
  reindexing: boolean;
  onEdit: () => void;
  onReindex: () => void;
}

export function ProfileCard({
  profile,
  generation,
  job,
  rerankerStatus,
  providers,
  reindexing,
  onEdit,
  onReindex,
}: ProfileCardProps) {
  const { t } = useTranslation('admin');
  const progress = generationProgress(generation);
  const disabled = profile.embedding_target.kind === 'disabled';
  const executing = reindexing || (!!job && isExecutingSemanticJob(job));
  const status = disabled
    ? 'disabled'
    : executing
      ? 'building'
      : job?.status === 'paused'
        ? 'paused'
        : job?.status === 'pending'
          ? 'pending'
          : generation?.status === 'building'
            ? 'paused'
            : generation?.status ?? 'pending';
  const PurposeIcon = profile.purpose === 'code'
    ? Code2
    : profile.purpose === 'docs'
      ? BookOpen
      : Sparkles;
  const rerankerDiagnostics = rerankerStatus.diagnostics;
  const localReranker = profile.reranker_target.kind === 'onnx';

  return (
    <Card className="flex min-h-[430px] flex-col">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-lg border bg-muted/40 p-2">
              <PurposeIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">
                {t(`semantic.purpose.${profile.purpose}.title`)}
              </CardTitle>
              <CardDescription className="mt-1">
                {t(`semantic.purpose.${profile.purpose}.description`)}
              </CardDescription>
            </div>
          </div>
          <Badge variant={disabled ? 'muted' : generationVariant(status)}>
            {t(`semantic.status.${status}`, { defaultValue: status })}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-4">
        <div className="grid gap-2">
          <div className="rounded-lg border bg-muted/10 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('semantic.summary.embedding')}
            </p>
            <p className="mt-1 truncate text-sm font-medium">
              {targetModel(profile.embedding_target) ?? t('semantic.status.disabled')}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {targetSource(profile.embedding_target, providers)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/10 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('semantic.summary.reranker')}
            </p>
            <p className="mt-1 truncate text-sm font-medium">
              {targetModel(profile.reranker_target) === 'auto'
                ? t('semantic.form.automaticModel')
                : targetModel(profile.reranker_target) ?? t('semantic.status.disabled')}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {targetSource(profile.reranker_target, providers)}
            </p>
          </div>
        </div>

        {localReranker && (
          <div className="rounded-lg border bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('semantic.rerankerRuntime.title')}
              </p>
              {rerankerDiagnostics && (
                <Badge variant={rerankerDiagnostics.enabled ? 'success' : 'warning'}>
                  {rerankerDiagnostics.policy === 'auto'
                    ? t('semantic.rerankerRuntime.policy.auto')
                    : t('semantic.rerankerRuntime.policy.explicit')}
                </Badge>
              )}
            </div>
            {rerankerStatus.error ? (
              <p className="mt-2 text-xs text-destructive">
                {t('semantic.rerankerRuntime.error', { message: rerankerStatus.error })}
              </p>
            ) : rerankerDiagnostics ? (
              <>
                <dl className="mt-2 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">
                      {t('semantic.rerankerRuntime.effectiveModel')}
                    </dt>
                    <dd className="truncate font-medium" title={rerankerDiagnostics.resolved_model ?? undefined}>
                      {rerankerDiagnostics.resolved_model ?? t('semantic.rerankerRuntime.rrfFallback')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('semantic.rerankerRuntime.dtype')}</dt>
                    <dd className="font-medium">{rerankerDiagnostics.dtype}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('semantic.rerankerRuntime.memory')}</dt>
                    <dd className="font-medium">{formatBytes(rerankerDiagnostics.estimated_peak_bytes)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('semantic.rerankerRuntime.provider')}</dt>
                    <dd className="font-medium">{rerankerDiagnostics.execution_provider}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('semantic.rerankerRuntime.lastLatency')}</dt>
                    <dd className="font-medium">
                      {rerankerDiagnostics.last_latency_ms == null
                        ? t('semantic.rerankerRuntime.notMeasured')
                        : `${Math.round(rerankerDiagnostics.last_latency_ms)} ms`}
                    </dd>
                  </div>
                </dl>
                {rerankerDiagnostics.downgrade_reason && (
                  <p className="mt-2 rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning">
                    {t('semantic.rerankerRuntime.downgrade', {
                      reason: rerankerDiagnostics.downgrade_reason,
                    })}
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('semantic.rerankerRuntime.unavailable')}
              </p>
            )}
          </div>
        )}

        <div className="rounded-lg border border-info/30 bg-info/5 p-3">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-info" />
            <p className="text-xs font-semibold">{t('semantic.storage.localTitle')}</p>
            <Badge variant="info">{t('semantic.storage.engine')}</Badge>
          </div>
          <div className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
            {profile.purpose === 'code' ? (
              <>
                <p>{t('semantic.storage.codePath')}</p>
                <p>{t('semantic.storage.codeFallback')}</p>
              </>
            ) : profile.purpose === 'docs' ? (
              <p>{t('semantic.storage.docsPath')}</p>
            ) : (
              <>
                <p>{t('semantic.storage.memoryProjectPath')}</p>
                <p>{t('semantic.storage.memoryProjectFallback')}</p>
                <p>{t('semantic.storage.memoryPath')}</p>
              </>
            )}
          </div>
        </div>

        {!disabled && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium">{t('semantic.coverage.title')}</span>
              <span className="tabular-nums text-muted-foreground">
                {progress.total > 0
                  ? t('semantic.coverage.value', {
                      indexed: progress.indexed,
                      total: progress.total,
                      percent: Math.round(progress.percent),
                    })
                  : t('semantic.coverage.waiting')}
              </span>
            </div>
            <Progress value={progress.percent} indeterminate={executing && progress.total === 0} />
            {progress.failed > 0 && (
              <p className="text-xs text-destructive">
                {t('semantic.coverage.failed', { count: progress.failed })}
              </p>
            )}
          </div>
        )}

        {generation?.error && (
          <Alert variant="destructive" className="py-2">
            <AlertCircle />
            <AlertDescription className="break-words text-xs">{generation.error}</AlertDescription>
          </Alert>
        )}
        {!generation?.error && job?.error && (
          <Alert variant="destructive" className="py-2">
            <AlertCircle />
            <AlertDescription className="break-words text-xs">{job.error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <CardFooter className="justify-end gap-2 border-t pt-4">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {t('semantic.actions.configure')}
        </Button>
        <Button
          size="sm"
          onClick={onReindex}
          disabled={disabled || executing}
        >
          {executing ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="mr-2 h-3.5 w-3.5" />
          )}
          {t('semantic.actions.reindex')}
        </Button>
      </CardFooter>
    </Card>
  );
}
