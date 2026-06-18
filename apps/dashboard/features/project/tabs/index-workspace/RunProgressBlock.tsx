/**
 * Bloco de progresso da run de index (extraído da RunsTab). Render puro a
 * partir de um IndexProgressState — sem estado próprio, reusável pelo card.
 */
import { AlertCircle, CheckCircle2, CircleStop, FileCode2, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Progress } from '../../../../components/ui/progress.js';
import { cn } from '../../../../lib/utils.js';
import { formatDuration, type IndexProgressState } from './index-run-types.js';

export function RunProgressBlock({ progress }: { progress: IndexProgressState }) {
  const { t } = useTranslation(['projects']);
  if (progress.status === 'idle') return null;
  const isRunning = progress.status === 'starting' || progress.status === 'running';
  return (
    <div className="rounded-lg border bg-card/80 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {isRunning && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          {progress.status === 'done' && <CheckCircle2 className="h-4 w-4 text-success" />}
          {progress.status === 'error' && <XCircle className="h-4 w-4 text-destructive" />}
          {progress.status === 'canceled' && <CircleStop className="h-4 w-4 text-muted-foreground" />}
          <span>
            {progress.status === 'starting'
              ? t('projects:runs.status.starting')
              : progress.status === 'running'
                ? t('projects:runs.status.indexing')
                : progress.status === 'done'
                  ? t('projects:runs.status.done')
                  : progress.status === 'error'
                    ? t('projects:runs.status.error')
                    : t('projects:runs.status.canceled')}
          </span>
        </div>
        <div className="text-sm tabular-nums text-muted-foreground">
          {progress.total > 0 ? `${progress.current}/${progress.total}` : '—'}
          <span className="ml-2 font-medium text-foreground">{progress.percent}%</span>
        </div>
      </div>

      <Progress
        value={progress.percent}
        indeterminate={progress.status === 'starting' || (progress.status === 'running' && progress.total === 0)}
        className={cn(
          progress.status === 'error' && '[&>div]:bg-destructive',
          progress.status === 'done' && '[&>div]:bg-success',
        )}
      />

      {progress.currentFile && isRunning && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground truncate">
          <FileCode2 className="h-3 w-3 shrink-0" />
          <span className="font-mono truncate">{progress.currentFile}</span>
        </div>
      )}

      <div className="flex items-center gap-4 text-xs text-muted-foreground tabular-nums pt-1 border-t">
        <span>{t('projects:runs.time', { duration: formatDuration(progress.elapsedMs || progress.result?.durationMs || 0) })}</span>
        <span>{t('projects:runs.cost', { cost: progress.costUsd.toFixed(4) })}</span>
        {progress.result && (
          <>
            <span>{t('projects:runs.skipped', { count: progress.result.skipped })}</span>
            {progress.result.errors > 0 && (
              <span className="text-destructive">{t('projects:runs.errors', { count: progress.result.errors })}</span>
            )}
          </>
        )}
      </div>

      {progress.status === 'error' && progress.message && (
        <div className="flex gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{progress.message}</span>
        </div>
      )}
    </div>
  );
}
