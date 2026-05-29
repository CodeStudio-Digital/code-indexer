/**
 * Read-only panel for `pipeline_telemetry` rows + aggregated histograms
 * + cache hit-rate stats. Loads fresh data on demand.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCcw, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { useConfirm, useNotify } from '../../components/ui/dialog-provider.js';
import {
  type CacheStat,
  type HistogramBucket,
  type TelemetryRow,
  type TelemetrySummary,
  fetchCacheStats,
  fetchHistogram,
  fetchSummary,
  fetchTelemetry,
  prunePipelineTelemetry,
} from './pipeline-telemetry-api.js';
import { SINCE_PRESETS, sinceForKey } from '../telemetry/since.js';

// Stored bucket values (must match durationToBucket/sizeToBucket in the store).
const BUCKETS_DURATION = ['0-10ms', '0-50ms', '50-500ms', '500-2500ms', '2500ms+'];
const BUCKETS_SIZE = ['0-10', '0-50', '50-500', '500-1000', '1000-2500', '2500+'];
// Friendly display labels — the buckets are disjoint, so "0-50ms" really means
// [10,50). Override the misleading ones without rewriting stored values.
const BUCKET_LABEL: Record<string, string> = { '0-50ms': '10-50ms', '0-50': '10-50' };

export function PipelineTelemetryPanel() {
  const { t } = useTranslation(['telemetry', 'common']);
  const confirm = useConfirm();
  const notify = useNotify();
  const [rows, setRows] = useState<TelemetryRow[]>([]);
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  const [histogram, setHistogram] = useState<HistogramBucket[]>([]);
  const [cacheStats, setCacheStats] = useState<CacheStat[]>([]);
  const [pipelineFilter, setPipelineFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [sinceKey, setSinceKey] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bucketField, setBucketField] = useState<'duration_bucket' | 'size_bucket'>('duration_bucket');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Same filters drive every block, so the cards, histogram, cache stats
      // and recent sample all describe the same population + time window.
      const filters = {
        pipelineName: pipelineFilter.trim() || undefined,
        stage: stageFilter.trim() || undefined,
        since: sinceForKey(sinceKey) ?? undefined,
      };
      const [telemRes, sumRes, histRes, cacheRes] = await Promise.all([
        fetchTelemetry({ ...filters, limit: 200 }),
        fetchSummary(filters),
        fetchHistogram({ ...filters, bucketField }),
        fetchCacheStats(filters),
      ]);
      setRows(telemRes.rows);
      setSummary(sumRes.summary);
      setHistogram(histRes.histogram);
      setCacheStats(cacheRes.stats);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketField, sinceKey]);

  // Cards come from the backend summary (window-wide), not a client-side sum of
  // the 200-row recent sample — so they match the histogram total.
  const events      = summary?.events ?? 0;
  const errorRows   = summary?.errorRows ?? 0;
  const subErrors   = summary?.subErrors ?? 0;
  const cacheHits   = summary?.cacheHits ?? 0;
  const cacheMisses = summary?.cacheMisses ?? 0;
  const hitRate     = summary?.hitRate ?? 0;

  const histogramMax = useMemo(
    () => histogram.reduce((max, b) => Math.max(max, b.count), 0),
    [histogram],
  );
  const bucketOrder = bucketField === 'duration_bucket' ? BUCKETS_DURATION : BUCKETS_SIZE;

  async function onPrune() {
    const ok = await confirm({
      title: t('telemetry:pipeline.confirmPrune.title'),
      description: t('telemetry:pipeline.confirmPrune.description'),
      variant: 'destructive',
      confirmLabel: t('telemetry:pipeline.confirmPrune.confirm'),
    });
    if (!ok) return;
    try {
      const res = await prunePipelineTelemetry();
      await notify({
        title: t('telemetry:pipeline.toasts.pruned.title'),
        description: t('telemetry:pipeline.toasts.pruned.description', { deleted: res.deleted, cutoff: res.cutoff }),
      });
      await load();
    } catch (e) {
      await notify({
        title: t('telemetry:pipeline.toasts.pruneFailed'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        {t('telemetry:pipeline.subtitle')}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder={t('telemetry:pipeline.filters.pipelineName')}
          value={pipelineFilter}
          onChange={(e) => setPipelineFilter(e.target.value)}
          className="w-48"
        />
        <Input
          placeholder={t('telemetry:pipeline.filters.stage')}
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className="w-32"
        />
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCcw className="h-3 w-3 mr-1" />}
          {t('telemetry:pipeline.actions.refresh')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onPrune()}>
          <Trash2 className="h-3 w-3 mr-1 text-red-500" /> {t('telemetry:pipeline.actions.prune')}
        </Button>
        <div className="inline-flex rounded border overflow-hidden text-xs">
          {SINCE_PRESETS.map((p) => (
            <button
              key={p.key}
              className={`px-2 py-1 ${sinceKey === p.key ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => setSinceKey(p.key)}
            >
              {t(`telemetry:filters.since.${p.key}`)}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="text-sm text-red-500">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Card><CardContent className="pt-4"><div className="text-xs text-muted-foreground">{t('telemetry:pipeline.stats.events')}</div><div className="text-2xl font-semibold">{events}</div></CardContent></Card>
        <Card><CardContent className="pt-4"><div className="text-xs text-muted-foreground">{t('telemetry:pipeline.stats.errorRows')}</div><div className="text-2xl font-semibold">{errorRows}</div>{subErrors > 0 && <div className="text-xs text-muted-foreground">{t('telemetry:pipeline.stats.subErrors', { count: subErrors })}</div>}</CardContent></Card>
        <Card><CardContent className="pt-4"><div className="text-xs text-muted-foreground">{t('telemetry:pipeline.stats.cacheHitsMisses')}</div><div className="text-2xl font-semibold">{cacheHits} / {cacheMisses}</div></CardContent></Card>
        <Card><CardContent className="pt-4"><div className="text-xs text-muted-foreground">{t('telemetry:pipeline.stats.hitRate')}</div><div className="text-2xl font-semibold">{(hitRate * 100).toFixed(1)}%</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">{t('telemetry:pipeline.histogram.title')}</CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant={bucketField === 'duration_bucket' ? 'default' : 'outline'} onClick={() => setBucketField('duration_bucket')}>{t('telemetry:pipeline.histogram.duration')}</Button>
            <Button size="sm" variant={bucketField === 'size_bucket' ? 'default' : 'outline'} onClick={() => setBucketField('size_bucket')}>{t('telemetry:pipeline.histogram.size')}</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {bucketOrder.map((label) => {
            const found = histogram.find((b) => b.bucket === label);
            const count = found?.count ?? 0;
            const pct = histogramMax > 0 ? (count / histogramMax) * 100 : 0;
            return (
              <div key={label} className="flex items-center gap-2 text-xs">
                <span className="w-24 font-mono">{BUCKET_LABEL[label] ?? label}</span>
                <div className="flex-1 h-3 rounded bg-muted overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-12 text-right font-mono">{count}</span>
              </div>
            );
          })}
          {histogram.length === 0 && <div className="text-xs text-muted-foreground italic">{t('telemetry:pipeline.histogram.empty')}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('telemetry:pipeline.cacheRate.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {cacheStats.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">{t('telemetry:pipeline.cacheRate.empty')}</div>
          ) : (
            cacheStats.map((s) => (
              <div key={`${s.pipeline_name}/${s.stage}/${s.component_name}`} className="flex items-center gap-2 text-xs">
                <span className="flex-1 font-mono truncate">{s.pipeline_name}/{s.stage}/{s.component_name}</span>
                <Badge variant="outline">{t('telemetry:pipeline.cacheRate.hits', { count: s.cache_hits })}</Badge>
                <Badge variant="outline">{t('telemetry:pipeline.cacheRate.misses', { count: s.cache_misses })}</Badge>
                <Badge>{(s.hit_rate * 100).toFixed(1)}%</Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('telemetry:pipeline.recent.title', { count: rows.length })}</CardTitle></CardHeader>
        <CardContent className="space-y-1 max-h-96 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">{t('telemetry:pipeline.recent.empty')}</div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-xs border-b py-1 last:border-b-0">
                <span className="font-mono text-muted-foreground">{new Date(r.created_at).toISOString().slice(11, 19)}</span>
                <span className="font-mono truncate flex-1">{r.pipeline_name}/{r.stage}/{r.component_name}</span>
                <Badge variant="outline" className="font-mono">{r.duration_bucket}</Badge>
                {r.candidates_in != null && (
                  <span className="font-mono text-muted-foreground">{r.candidates_in}→{r.candidates_out}</span>
                )}
                {r.errors > 0 && <Badge variant="destructive">{t('telemetry:pipeline.recent.errorsBadge', { count: r.errors })}</Badge>}
                {(r.cache_hits + r.cache_misses) > 0 && (
                  <Badge variant="outline" className="font-mono">{r.cache_hits}/{r.cache_hits + r.cache_misses}</Badge>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
