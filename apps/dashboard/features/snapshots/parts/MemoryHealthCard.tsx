/**
 * Memory health card — the diagnostics strip at the top of the project
 * Memory tab. Answers the question that made the old pipeline feel dead:
 * "is this project actually learning anything?" Shows the last distillation
 * (when / which trigger / what landed), totals by category and provenance,
 * and the per-project automatic-memory toggle (projects.memory_enabled).
 */
import { useTranslation } from 'react-i18next';
import { Brain, CircleAlert, RefreshCw } from 'lucide-react';
import { Switch } from '../../../components/ui/switch.js';
import { apiPatch, useApi } from '../../../hooks/useApi.js';
import { cn, formatRelativeTime } from '../../../lib/utils.js';
import { CATEGORY_COLORS } from '../snapshot-types.js';

interface DistillEntry {
  trigger: string;
  status: string;
  created: number;
  merged: number;
  skipped: number;
  error: string | null;
  created_at: string;
}

interface MemoryHealth {
  memory_enabled: boolean;
  last: DistillEntry | null;
  totals: {
    total: number;
    byCategory: Record<string, number>;
    bySource: Record<string, number>;
  };
}

export function MemoryHealthCard({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const { data, refetch } = useApi<MemoryHealth>(`/projects/${projectId}/memory/health`);

  if (!data) return null;
  const { last, totals } = data;

  const toggle = async (enabled: boolean) => {
    await apiPatch(`/projects/${projectId}`, { memory_enabled: enabled });
    refetch();
  };

  return (
    <div className="border-b bg-muted/30 px-3 py-2 space-y-1.5 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <Brain className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium">{t('memory.health.title')}</span>
        <span className="text-[10px] text-muted-foreground">
          {t('memory.health.total', { count: totals.total })}
        </span>
        <button
          type="button"
          onClick={refetch}
          aria-label={t('memory.health.refresh')}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          {t('memory.toggle.label')}
          <Switch checked={data.memory_enabled} onCheckedChange={toggle} />
        </label>
      </div>

      <div className="text-[10px] text-muted-foreground flex items-center gap-1.5 min-w-0">
        {last ? (
          <>
            <span
              className={cn(
                'px-1 rounded font-medium',
                last.status === 'error'
                  ? 'bg-red-500/15 text-red-600 dark:text-red-300'
                  : last.status === 'empty'
                    ? 'bg-muted'
                    : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
              )}
            >
              {last.status}
            </span>
            <span className="truncate">
              {t('memory.health.lastDistill', {
                when: formatRelativeTime(last.created_at),
                trigger: last.trigger,
                created: last.created,
                merged: last.merged,
              })}
            </span>
            {last.error && (
              <span className="flex items-center gap-0.5 text-red-500 truncate" title={last.error}>
                <CircleAlert className="h-3 w-3 shrink-0" />
                <span className="truncate">{last.error}</span>
              </span>
            )}
          </>
        ) : (
          <span>{t('memory.health.never')}</span>
        )}
      </div>

      {totals.total > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {Object.entries(totals.byCategory).map(([cat, n]) => (
            <span
              key={cat}
              className={cn(
                'px-1.5 py-0.5 rounded text-[9px] font-medium capitalize',
                CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.note,
              )}
            >
              {cat} {n}
            </span>
          ))}
          <span className="text-[9px] text-muted-foreground ml-1">
            {Object.entries(totals.bySource)
              .map(([src, n]) => `${t(`memory.source.${src}`, src)} ${n}`)
              .join(' · ')}
          </span>
        </div>
      )}
    </div>
  );
}
