import { useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, History, Loader2, RefreshCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { getAppSpecHistory, type AppSpecHistoryView, type AppSpecImpactView, type AppStudioSessionDetail } from '../app-studio-api.js';

const IMPACT_CLASS: Record<AppSpecImpactView['level'], string> = {
  none: 'border-muted text-muted-foreground',
  low: 'border-blue-300 bg-blue-50 text-blue-700',
  medium: 'border-amber-300 bg-amber-50 text-amber-700',
  high: 'border-red-300 bg-red-50 text-red-700',
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

export function VersionsPanel({ detail }: { detail: AppStudioSessionDetail; onChanged: () => void }) {
  const { t } = useTranslation('appStudio');
  const [history, setHistory] = useState<AppSpecHistoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setHistory(await getAppSpecHistory(detail.session.id));
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [detail.session.id]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <GitBranch className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{t('versions.title')}</h2><p className="text-xs text-muted-foreground">{t('workflow.versionHistoryHelp')}</p></div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>{loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="mr-1 h-3.5 w-3.5" />}{t('versions.refresh')}</Button>
      </header>
      {error && <p className="m-4 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-5xl space-y-5">
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4" />{t('versions.history')}</h3>
            <div className="space-y-2">
              {(history?.revisions ?? []).map((revision) => (
                <article key={revision.id} className="rounded-md border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2"><strong className="font-mono text-xs">{t('versions.version', { number: revision.revision_number })}</strong><span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{revision.status}</span><span className="min-w-0 flex-1 truncate text-sm">{revision.title || revision.spec_summary?.summary || '—'}</span><time className="text-xs text-muted-foreground">{formatDate(revision.created_at)}</time></div>
                  {revision.summary && <p className="mt-2 text-xs text-muted-foreground">{revision.summary}</p>}
                </article>
              ))}
              {!loading && (history?.revisions.length ?? 0) === 0 && <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t('versions.noProposal')}</p>}
            </div>
          </section>
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-600" />{t('versions.changes')}</h3>
            <div className="space-y-2">
              {(history?.evolutions ?? []).map((evolution) => (
                <article key={evolution.id} className="rounded-md border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{evolution.title}</strong><span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{evolution.status}</span>{evolution.impact && <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold', IMPACT_CLASS[evolution.impact.level])}>{t(`versions.impact.${evolution.impact.level}`)}</span>}<time className="ml-auto text-xs text-muted-foreground">{formatDate(evolution.created_at)}</time></div>
                  {evolution.description && <p className="mt-1 text-xs text-muted-foreground">{evolution.description}</p>}
                  {evolution.impact && <div className="mt-2 text-xs"><p>{(evolution.impact.affected_phases ?? []).map((phase) => t(`workflow.phases.${phase}`)).join(' · ') || t('versions.impact.none')}</p><p className="mt-1 text-muted-foreground">{(evolution.impact.reasons ?? []).join(' · ')}</p></div>}
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
