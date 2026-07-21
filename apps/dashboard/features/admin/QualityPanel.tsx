import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCcw, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Switch } from '../../components/ui/switch.js';
import { useConfirm, useNotify } from '../../components/ui/dialog-provider.js';
import {
  type QualityOverview,
  type QualityRow,
  type QualityStatus,
  type QualityVerdict,
  clearAllQuality,
  fetchQualityEnabled,
  fetchQualityOverview,
  fetchQualityScopedRows,
  pruneQuality,
  setQualityEnabled,
} from './quality-api.js';

const DIMENSIONS = [
  'delivery_overall',
  'delivery_relevance',
  'delivery_completeness',
  'evidence_alignment',
];

const VERDICT_COLOR: Record<QualityVerdict, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  flagged: 'bg-red-500',
  error: 'bg-slate-500',
};

type QualityLoadSection = 'status' | 'overview' | 'delivery' | 'runtime' | 'legacy';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function QualityPanel() {
  const { t } = useTranslation(['telemetry', 'common']);
  const confirm = useConfirm();
  const notify = useNotify();
  const [status, setStatus] = useState<QualityStatus | null>(null);
  const [overview, setOverview] = useState<QualityOverview | null>(null);
  const [deliveryRows, setDeliveryRows] = useState<QualityRow[]>([]);
  const [runtimeRows, setRuntimeRows] = useState<QualityRow[]>([]);
  const [legacyRows, setLegacyRows] = useState<QualityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [failedSections, setFailedSections] = useState<Set<QualityLoadSection>>(new Set());
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verdictLabel: Record<QualityVerdict, string> = {
    ok: t('telemetry:quality.verdict.ok'),
    warn: t('telemetry:quality.verdict.warn'),
    flagged: t('telemetry:quality.verdict.flagged'),
    error: t('telemetry:quality.verdict.error'),
  };

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextOverview, delivery, runtime, legacy] = await Promise.allSettled([
        fetchQualityEnabled(),
        fetchQualityOverview(),
        fetchQualityScopedRows('delivery', { limit: 200 }),
        fetchQualityScopedRows('runtime', { limit: 100 }),
        fetchQualityScopedRows('legacy', { limit: 50 }),
      ] as const);
      const failed = new Set<QualityLoadSection>();
      const errors: string[] = [];
      const reject = (section: QualityLoadSection, reason: unknown) => {
        failed.add(section);
        errors.push(errorMessage(reason));
      };

      if (nextStatus.status === 'fulfilled') setStatus(nextStatus.value);
      else { setStatus(null); reject('status', nextStatus.reason); }
      if (nextOverview.status === 'fulfilled') setOverview(nextOverview.value);
      else { setOverview(null); reject('overview', nextOverview.reason); }
      if (delivery.status === 'fulfilled') setDeliveryRows(delivery.value.rows);
      else { setDeliveryRows([]); reject('delivery', delivery.reason); }
      if (runtime.status === 'fulfilled') setRuntimeRows(runtime.value.rows);
      else { setRuntimeRows([]); reject('runtime', runtime.reason); }
      if (legacy.status === 'fulfilled') setLegacyRows(legacy.value.rows);
      else { setLegacyRows([]); reject('legacy', legacy.reason); }

      setFailedSections(failed);
      setError(errors.length > 0 ? errors.join(' · ') : null);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }

  useEffect(() => { void load(); }, []);

  const dimensionCounts = useMemo(() => {
    const result = new Map<string, Record<QualityVerdict, number>>();
    for (const dimension of DIMENSIONS) result.set(dimension, { ok: 0, warn: 0, flagged: 0, error: 0 });
    for (const row of deliveryRows) {
      const counts = result.get(row.classifier_name);
      if (counts && !row.system_error) counts[row.verdict] += 1;
    }
    return result;
  }, [deliveryRows]);

  const assessments = useMemo(() => {
    const map = new Map<string, QualityRow[]>();
    for (const row of deliveryRows) {
      if (row.system_error) continue;
      const key = row.assessment_id ?? `row-${row.id}`;
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return [...map.entries()].slice(0, 30);
  }, [deliveryRows]);
  const infrastructureRows = useMemo(
    () => deliveryRows.filter((row) => row.system_error === 1).slice(0, 30),
    [deliveryRows],
  );

  async function toggle(enabled: boolean) {
    setToggling(true);
    try {
      const next = await setQualityEnabled(enabled);
      setStatus(next);
      if (enabled && !next.enabled) {
        await notify({
          title: t('telemetry:quality.workers.ackFailed'),
          description: t('telemetry:quality.workers.ackFailedDescription', { failed: next.workers.failed }),
          variant: 'destructive',
        });
      }
    } catch (e) {
      await notify({
        title: t('telemetry:quality.toasts.toggleFailed'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    } finally {
      setToggling(false);
    }
  }

  async function prune(all = false) {
    const ok = await confirm({
      title: t(all ? 'telemetry:quality.confirmClearAll.title' : 'telemetry:quality.confirmPrune.title'),
      description: t(all ? 'telemetry:quality.confirmClearAll.description' : 'telemetry:quality.confirmPrune.description'),
      variant: 'destructive',
      confirmLabel: t(all ? 'telemetry:quality.confirmClearAll.confirm' : 'telemetry:quality.confirmPrune.confirm'),
    });
    if (!ok) return;
    try {
      const result = all ? await clearAllQuality() : await pruneQuality();
      await notify({
        title: t('telemetry:quality.toasts.pruned.title'),
        description: t('telemetry:quality.toasts.pruned.description', { deleted: result.deleted }),
      });
      await load();
    } catch (e) {
      await notify({ title: t('telemetry:quality.toasts.pruneFailed'), description: (e as Error).message, variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">{t('telemetry:quality.subtitle')}</div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded border px-2.5 py-1">
          <Switch checked={status?.enabled === true} disabled={!status || toggling} onCheckedChange={(value) => void toggle(value)} />
          <span className="text-xs text-muted-foreground">
            {status == null
              ? t(loaded ? 'telemetry:quality.actions.unavailable' : 'telemetry:quality.actions.loading')
              : status.enabled
                ? t('telemetry:quality.actions.enabled')
                : t('telemetry:quality.actions.disabled')}
          </span>
        </div>
        {status && (
          <Badge variant={status.workers.failed > 0 ? 'destructive' : 'outline'}>
            {t('telemetry:quality.workers.ack', { acknowledged: status.workers.acknowledged, total: status.workers.total })}
          </Badge>
        )}
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCcw className="mr-1 h-3 w-3" />}
          {t('telemetry:quality.actions.refresh')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void prune(false)}><Trash2 className="mr-1 h-3 w-3 text-red-500" />{t('telemetry:quality.actions.prune')}</Button>
        <Button size="sm" variant="ghost" onClick={() => void prune(true)}><Trash2 className="mr-1 h-3 w-3 text-red-500" />{t('telemetry:quality.actions.clearAll')}</Button>
      </div>

      {error && <div className="text-sm text-red-500">{error}</div>}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('telemetry:quality.coverage.title')}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label={t('telemetry:quality.coverage.completed')} value={overview?.completedTasks ?? (loaded ? '—' : '…')} />
          <Metric label={t('telemetry:quality.coverage.assessments')} value={overview?.assessments ?? (loaded ? '—' : '…')} />
          <Metric label={t('telemetry:quality.coverage.requests')} value={overview?.llmRequests ?? (loaded ? '—' : '…')} />
          <Metric label={t('telemetry:quality.coverage.tokens')} value={overview ? overview.tokensIn + overview.tokensOut : loaded ? '—' : '…'} />
          <Metric label={t('telemetry:quality.coverage.latency')} value={overview ? `${Math.round(overview.averageLatencyMs)}ms` : loaded ? '—' : '…'} />
          <Metric label={t('telemetry:quality.coverage.infrastructure')} value={overview?.infrastructureFailures ?? (loaded ? '—' : '…')} />
          <Metric label={t('telemetry:quality.coverage.incidents')} value={overview?.runtimeIncidents ?? (loaded ? '—' : '…')} />
        </CardContent>
      </Card>

      <RowsCard
        title={t('telemetry:quality.infrastructure.title')}
        empty={t('telemetry:quality.infrastructure.empty')}
        rows={infrastructureRows}
        verdictLabel={verdictLabel}
        loading={!loaded}
        unavailable={failedSections.has('delivery') ? t('telemetry:quality.sectionUnavailable') : undefined}
      />

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('telemetry:quality.delivery.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {DIMENSIONS.map((dimension) => {
            const counts = dimensionCounts.get(dimension)!;
            const total = counts.ok + counts.warn + counts.flagged + counts.error;
            return (
              <div key={dimension} className="flex items-center gap-2 text-xs">
                <span className="w-44 font-mono">{dimension}</span>
                <div className="flex h-4 flex-1 overflow-hidden rounded bg-muted">
                  {(Object.keys(counts) as QualityVerdict[]).map((verdict) => {
                    const width = total > 0 ? counts[verdict] / total * 100 : 0;
                    return width > 0 ? <div key={verdict} className={VERDICT_COLOR[verdict]} style={{ width: `${width}%` }} title={`${verdictLabel[verdict]}: ${counts[verdict]}`} /> : null;
                  })}
                </div>
                <span className="w-10 text-right font-mono">{failedSections.has('delivery') ? '—' : total}</span>
              </div>
            );
          })}
          <div className="max-h-80 space-y-2 overflow-y-auto border-t pt-2">
            {!loaded
              ? <div className="text-xs italic text-muted-foreground">{t('telemetry:quality.loading')}</div>
              : failedSections.has('delivery')
                ? <div className="text-xs text-red-500">{t('telemetry:quality.sectionUnavailable')}</div>
                : assessments.length === 0 ? <div className="text-xs italic text-muted-foreground">{t('telemetry:quality.delivery.empty')}</div> : assessments.map(([id, rows]) => (
              <div key={id} className="rounded border p-2 text-xs">
                <div className="mb-1 flex gap-2 text-muted-foreground">
                  <span>{rows[0]?.created_at}</span><span>{t('telemetry:quality.delivery.round')} {rows[0]?.round_message_id ?? '—'}</span><span className="ml-auto font-mono">{id.slice(0, 8)}</span>
                </div>
                {rows.map((row) => (
                  <div key={row.id} className="flex items-center gap-2 py-0.5">
                    <Badge className={`${VERDICT_COLOR[row.verdict]} text-white`}>{verdictLabel[row.verdict]}</Badge>
                    <span className="w-40 font-mono">{row.classifier_name}</span>
                    <span className="flex-1 truncate" title={row.reason ?? ''}>{row.reason ?? '—'}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <RowsCard title={t('telemetry:quality.runtime.title')} empty={t('telemetry:quality.runtime.empty')} rows={runtimeRows} verdictLabel={verdictLabel} loading={!loaded} unavailable={failedSections.has('runtime') ? t('telemetry:quality.sectionUnavailable') : undefined} />
      <RowsCard title={t('telemetry:quality.legacy.title')} empty={t('telemetry:quality.legacy.empty')} rows={legacyRows} verdictLabel={verdictLabel} loading={!loaded} unavailable={failedSections.has('legacy') ? t('telemetry:quality.sectionUnavailable') : undefined} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="text-2xl font-semibold">{value}</div></div>;
}

function RowsCard({ title, empty, rows, verdictLabel, loading, unavailable }: {
  title: string;
  empty: string;
  rows: QualityRow[];
  verdictLabel: Record<QualityVerdict, string>;
  loading?: boolean;
  unavailable?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="max-h-72 space-y-1 overflow-y-auto">
        {unavailable
          ? <div className="text-xs text-red-500">{unavailable}</div>
          : loading
            ? <div className="text-xs italic text-muted-foreground">…</div>
            : rows.length === 0 ? <div className="text-xs italic text-muted-foreground">{empty}</div> : rows.map((row) => {
          const evidence = formatEvidence(row.evidence_json);
          return (
            <div key={row.id} className="flex items-center gap-2 border-b py-1 text-xs last:border-0">
              <span className="w-20 font-mono text-muted-foreground">{row.created_at.slice(11, 19)}</span>
              <Badge className={`${VERDICT_COLOR[row.verdict]} text-white`}>{verdictLabel[row.verdict]}</Badge>
              <span className="w-40 truncate font-mono">{row.classifier_name}</span>
              <span className="flex-1 truncate" title={row.reason ?? ''}>{row.reason ?? '—'}</span>
              <span className="w-48 truncate font-mono text-muted-foreground" title={evidence}>{evidence || '—'}</span>
              <Badge variant="outline">{row.action_taken}</Badge>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function formatEvidence(value: string | null): string {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.entries(parsed).slice(0, 5).map(([key, item]) => {
      if (item == null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        return `${key}=${String(item).slice(0, 80)}`;
      }
      if (Array.isArray(item)) return `${key}=[${item.length}]`;
      return `${key}={…}`;
    }).join(' · ');
  } catch {
    return '';
  }
}
