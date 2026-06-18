/**
 * Lista de runs históricas de index (extraído da RunsTab). Re-busca quando uma
 * run em andamento chega a um estado terminal (`refreshKey` muda para
 * done/error/canceled), substituindo o antigo `refetch()` acoplado ao fetch.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../../../components/ui/button.js';
import { useApi } from '../../../../hooks/useApi.js';
import { cn } from '../../../../lib/utils.js';
import type { Run } from '../../types.js';

export function RunHistoryList({ projectId, refreshKey }: { projectId: number; refreshKey: string }) {
  const { t } = useTranslation(['projects', 'common']);
  const { data: runs, loading, refetch } = useApi<Run[]>(`/projects/${projectId}/runs`);

  useEffect(() => {
    if (refreshKey === 'done' || refreshKey === 'error' || refreshKey === 'canceled') refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {t('projects:runs.history')}
        </h3>
        <Button variant="ghost" size="sm" onClick={refetch} className="h-7 gap-1.5">
          <RefreshCw className="h-3 w-3" /> {t('common:actions.refresh')}
        </Button>
      </div>
      {loading ? (
        <div className="text-muted-foreground text-sm">{t('common:actions.loading')}</div>
      ) : !runs || runs.length === 0 ? (
        <div className="text-muted-foreground text-sm border border-dashed rounded-lg px-4 py-8 text-center">
          {t('projects:runs.noRuns')}
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((r) => (
            <div key={r.id} className="flex items-center justify-between p-3 rounded-lg border bg-card">
              <div className="flex items-center gap-3">
                <span
                  title={r.status}
                  className={cn(
                    'h-2 w-2 rounded-full',
                    r.status === 'completed'
                      ? 'bg-success'
                      : r.status === 'completed_with_errors'
                        ? 'bg-warning'
                        : r.status === 'running'
                          ? 'bg-warning animate-pulse'
                          : 'bg-destructive',
                  )}
                />
                <span className="text-sm font-medium">{t('projects:runs.runLabel', { id: r.id })}</span>
                <span className="text-xs text-muted-foreground">{new Date(r.started_at).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground tabular-nums">
                <span>{t('projects:runs.filesCount', { indexed: r.indexed_files, total: r.total_files })}</span>
                {r.error_count > 0 && (
                  <span className="text-warning">{t('projects:runs.errorsCount', { count: r.error_count })}</span>
                )}
                <span>${r.estimated_cost_usd.toFixed(4)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
