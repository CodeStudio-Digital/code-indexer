/**
 * Card de embeddings (extraído da RunsTab): cobertura (files/symbols/bodies),
 * progresso de retry e botão de retry. Só renderiza quando há cobertura. O pai
 * passa `indexRunning` (desabilita o retry durante uma run) e `coverageRefreshKey`
 * (quando vira 'done', re-busca a cobertura).
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, CircleStop, Database, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '../../../../components/ui/badge.js';
import { Button } from '../../../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card.js';
import { Progress } from '../../../../components/ui/progress.js';
import { cn } from '../../../../lib/utils.js';
import { useEmbeddingRetry } from './useEmbeddingRetry.js';

interface EmbeddingsCardProps {
  projectId: number;
  indexRunning: boolean;
  /** Status da run de index; quando vira 'done' a cobertura é re-buscada. */
  coverageRefreshKey: string;
}

export function EmbeddingsCard({ projectId, indexRunning, coverageRefreshKey }: EmbeddingsCardProps) {
  const { t } = useTranslation(['projects', 'common']);
  const { coverage, embedProgress, isEmbedRunning, startRetry, cancelRetry, resetEmbed, refetchCoverage } =
    useEmbeddingRetry(projectId);

  useEffect(() => {
    if (coverageRefreshKey === 'done') refetchCoverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverageRefreshKey]);

  if (!coverage) return null;

  const total = coverage.files_total + coverage.symbols_total + coverage.symbol_bodies_total;
  const done = coverage.files_embedded + coverage.symbols_embedded + coverage.symbol_bodies_embedded;
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;

  return (
    <Card className="border-muted">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-muted text-muted-foreground flex items-center justify-center shadow-sm">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">{t('projects:runs.embeddings.title')}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{t('projects:runs.embeddings.description')}</p>
            </div>
          </div>
          <Badge variant={pct >= 100 ? 'success' : pct > 0 ? 'warning' : 'destructive'}>
            {t('projects:runs.embeddings.badge', { done, total, pct })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg border bg-card px-3 py-2">
            <span className="text-muted-foreground text-xs">{t('projects:runs.embeddings.files')}</span>
            <div className="font-medium tabular-nums">{coverage.files_embedded}/{coverage.files_total}</div>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <span className="text-muted-foreground text-xs">{t('projects:runs.embeddings.symbols')}</span>
            <div className="font-medium tabular-nums">{coverage.symbols_embedded}/{coverage.symbols_total}</div>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <span className="text-muted-foreground text-xs">{t('projects:runs.embeddings.bodies')}</span>
            <div className="font-medium tabular-nums">{coverage.symbol_bodies_embedded}/{coverage.symbol_bodies_total}</div>
          </div>
        </div>

        {embedProgress.status !== 'idle' && (
          <div className="rounded-lg border bg-card/80 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                {isEmbedRunning && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                {embedProgress.status === 'done' && <CheckCircle2 className="h-4 w-4 text-success" />}
                {embedProgress.status === 'error' && <XCircle className="h-4 w-4 text-destructive" />}
                <span>
                  {embedProgress.status === 'starting'
                    ? t('projects:runs.embeddings.status.starting')
                    : embedProgress.status === 'running'
                      ? t('projects:runs.embeddings.status.embedding')
                      : embedProgress.status === 'done'
                        ? t('projects:runs.embeddings.status.done')
                        : t('projects:runs.embeddings.status.error')}
                </span>
              </div>
              <div className="text-sm tabular-nums text-muted-foreground">
                {embedProgress.total > 0 ? `${embedProgress.current}/${embedProgress.total}` : '—'}
                <span className="ml-2 font-medium text-foreground">{embedProgress.percent}%</span>
              </div>
            </div>

            <Progress
              value={embedProgress.percent}
              indeterminate={embedProgress.status === 'starting' || (embedProgress.status === 'running' && embedProgress.total === 0)}
              className={cn(
                embedProgress.status === 'error' && '[&>div]:bg-destructive',
                embedProgress.status === 'done' && '[&>div]:bg-success',
              )}
            />

            {embedProgress.result && (
              <div className="flex items-center gap-4 text-xs text-muted-foreground tabular-nums pt-1 border-t">
                <span>{t('projects:runs.embeddings.embedded', { count: embedProgress.result.embedded })}</span>
                <span>{t('projects:runs.embeddings.tokens', { count: embedProgress.result.tokens.toLocaleString() })}</span>
              </div>
            )}

            {embedProgress.status === 'error' && embedProgress.message && (
              <div className="flex gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{embedProgress.message}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          {isEmbedRunning ? (
            <Button variant="destructive" size="sm" onClick={cancelRetry} className="gap-2">
              <CircleStop className="h-4 w-4" /> {t('common:actions.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={startRetry}
              disabled={indexRunning || isEmbedRunning}
              className="gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              {embedProgress.status === 'done' || embedProgress.status === 'error'
                ? t('projects:runs.embeddings.retryAgain')
                : t('projects:runs.embeddings.retry')}
            </Button>
          )}
          {embedProgress.status !== 'idle' && !isEmbedRunning && (
            <Button variant="ghost" size="sm" onClick={resetEmbed} className="gap-2">
              <RefreshCw className="h-4 w-4" /> {t('common:actions.clear')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
