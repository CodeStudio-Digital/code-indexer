import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, RefreshCw } from 'lucide-react';
import { Switch } from '../../../components/ui/switch.js';
import { apiPatch, useApi } from '../../../hooks/useApi.js';
import { formatRelativeTime } from '../../../lib/utils.js';

interface MemoryHealth {
  memory_enabled: boolean;
  last: { status: string; trigger: string; created_at: string; created: number; merged: number; error: string | null } | null;
  totals: { total: number; archived: number; byCategory: Record<string, number> };
}

/** Counts from the active store, with explicitly historical extraction logs. */
export function MemoryHealthCard({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const { data, loading, error, refetch } = useApi<MemoryHealth>(`/projects/${projectId}/memory/health`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toggle = async (enabled: boolean) => {
    setSaving(true); setActionError(null);
    try { await apiPatch(`/projects/${projectId}`, { memory_enabled: enabled }); refetch(); }
    catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return (
    <div className="border-b bg-muted/30 px-3 py-2 space-y-2 shrink-0">
      <div className="flex flex-wrap items-center gap-2">
        <Brain className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">{t('memory.health.title')}</span>
        {data && <span className="text-xs text-muted-foreground">{t('memory.health.total', { count: data.totals.total })}</span>}
        <button type="button" onClick={refetch} aria-label={t('memory.health.refresh')} className="p-1 rounded hover:bg-muted"><RefreshCw className="h-3 w-3" /></button>
        {data && <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {t('memory.toggle.label')}<Switch disabled={saving} checked={data.memory_enabled} onCheckedChange={toggle} />
        </label>}
      </div>
      {(error || actionError) && <p role="alert" className="text-xs text-destructive">{error || actionError}</p>}
      {loading && !data && <p className="text-xs text-muted-foreground">{t('memory.curation.loading')}</p>}
      {data && <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
        {Object.entries(data.totals.byCategory).map(([category, count]) => <span key={category} className="rounded bg-muted px-1.5 py-0.5">{category} {count}</span>)}
      </div>}
      {data?.last && <details className="text-[10px] text-muted-foreground">
        <summary className="cursor-pointer">{t('memory.health.historicalTitle')}</summary>
        <p>{t('memory.health.historicalHint')}</p>
        <p>{data.last.status} · {data.last.trigger} · {formatRelativeTime(data.last.created_at)} · +{data.last.created} / {data.last.merged}</p>
        {data.last.error && <p className="text-destructive">{data.last.error}</p>}
      </details>}
    </div>
  );
}
