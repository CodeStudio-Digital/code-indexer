/**
 * QualityPanel — verdict distribution per classifier + drill-down into
 * recent rows. Read-only.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCcw, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { useConfirm, useNotify } from '../../components/ui/dialog-provider.js';
import {
  type CounterfactualStats,
  type InterventionEffectivenessStats,
  type QualityRow,
  type QualityVerdict,
  type VerdictDistribution,
  fetchCounterfactualStats,
  fetchInterventionEffectiveness,
  fetchQualityDistribution,
  fetchQualityRows,
  pruneQuality,
} from './quality-api.js';

const CLASSIFIERS = ['off_topic', 'completeness', 'code_quality', 'policy', 'tool_misuse'];

const VERDICT_COLOR: Record<QualityVerdict, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  flagged: 'bg-red-500',
  error: 'bg-slate-500',
};

export function QualityPanel() {
  const { t } = useTranslation(['telemetry', 'common']);
  const confirm = useConfirm();
  const notify = useNotify();
  // Verdict labels are translated per-render (i18n needs hook context) —
  // see VERDICT_COLOR for the colors, which are language-independent.
  const verdictLabel: Record<QualityVerdict, string> = {
    ok: t('telemetry:quality.verdict.ok'),
    warn: t('telemetry:quality.verdict.warn'),
    flagged: t('telemetry:quality.verdict.flagged'),
    error: t('telemetry:quality.verdict.error'),
  };
  const [distribution, setDistribution] = useState<VerdictDistribution[]>([]);
  const [cfStats, setCfStats] = useState<CounterfactualStats | null>(null);
  const [interventionStats, setInterventionStats] = useState<InterventionEffectivenessStats | null>(null);
  const [selected, setSelected] = useState<string>('off_topic');
  const [rows, setRows] = useState<QualityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAggregates() {
    setLoading(true);
    setError(null);
    try {
      const [d, cf, ie] = await Promise.all([
        fetchQualityDistribution(),
        fetchCounterfactualStats(),
        fetchInterventionEffectiveness({ recentLimit: 20 }),
      ]);
      setDistribution(d.distribution);
      setCfStats(cf);
      setInterventionStats(ie);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadRows(classifier: string) {
    setLoading(true);
    try {
      const r = await fetchQualityRows({ classifierName: classifier, limit: 100 });
      setRows(r.rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAggregates(); }, []);
  useEffect(() => { void loadRows(selected); }, [selected]);

  const perClassifier = useMemo(() => {
    const map = new Map<string, Record<QualityVerdict, number>>();
    for (const c of CLASSIFIERS) {
      map.set(c, { ok: 0, warn: 0, flagged: 0, error: 0 });
    }
    for (const d of distribution) {
      const m = map.get(d.classifier_name);
      if (m) m[d.verdict] = d.count;
    }
    return map;
  }, [distribution]);

  // The REAL nudge lift: improved-rate WITH a nudge minus improved-rate when
  // the nudge was held out (withheld) on the same population. `nudge_suppressed`
  // is NOT a baseline (it's the repeat/dedup'd subset), so we compare against
  // `nudge_holdout` only. Null until both arms have measured outcomes.
  const lift = useMemo(() => {
    if (!interventionStats) return null;
    const nudge = interventionStats.byType.find((r) => r.intervention_type === 'nudge');
    const holdout = interventionStats.byType.find((r) => r.intervention_type === 'nudge_holdout');
    if (!nudge || !holdout || nudge.measured === 0 || holdout.measured === 0) return null;
    return {
      pp: nudge.improved_rate - holdout.improved_rate,
      nudge: Math.round(nudge.improved_rate * 100),
      holdout: Math.round(holdout.improved_rate * 100),
    };
  }, [interventionStats]);

  // Translate an intervention_type to a friendly label; falls back to the raw
  // key so unknown types still render.
  const typeLabel = (type: string): string =>
    t(`telemetry:quality.interventions.type.${type}`, { defaultValue: type });

  async function onPrune() {
    const ok = await confirm({
      title: t('telemetry:quality.confirmPrune.title'),
      description: t('telemetry:quality.confirmPrune.description'),
      variant: 'destructive',
      confirmLabel: t('telemetry:quality.confirmPrune.confirm'),
    });
    if (!ok) return;
    try {
      const res = await pruneQuality();
      await notify({
        title: t('telemetry:quality.toasts.pruned.title'),
        description: t('telemetry:quality.toasts.pruned.description', { deleted: res.deleted }),
      });
      await loadAggregates();
      await loadRows(selected);
    } catch (e) {
      await notify({
        title: t('telemetry:quality.toasts.pruneFailed'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        {t('telemetry:quality.subtitle')}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => { void loadAggregates(); void loadRows(selected); }} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCcw className="h-3 w-3 mr-1" />}
          {t('telemetry:quality.actions.refresh')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onPrune()}>
          <Trash2 className="h-3 w-3 mr-1 text-red-500" /> {t('telemetry:quality.actions.prune')}
        </Button>
      </div>

      {error && <div className="text-sm text-red-500">{error}</div>}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('telemetry:quality.distribution.title')}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {CLASSIFIERS.map((c) => {
            const counts = perClassifier.get(c)!;
            const total = counts.ok + counts.warn + counts.flagged + counts.error;
            const isSelected = c === selected;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setSelected(c)}
                className={`w-full text-left flex items-center gap-2 p-2 rounded border transition-colors ${
                  isSelected ? 'border-primary bg-muted/50' : 'border-transparent hover:border-muted'
                }`}
              >
                <span className="font-mono text-xs w-32">{c}</span>
                <div className="flex-1 h-4 rounded bg-muted overflow-hidden flex">
                  {(['ok', 'warn', 'flagged', 'error'] as QualityVerdict[]).map((v) => {
                    const pct = total > 0 ? (counts[v] / total) * 100 : 0;
                    if (pct === 0) return null;
                    return (
                      <div
                        key={v}
                        className={`${VERDICT_COLOR[v]} h-full`}
                        style={{ width: `${pct}%` }}
                        title={`${verdictLabel[v]}: ${counts[v]}`}
                      />
                    );
                  })}
                </div>
                <span className="text-xs font-mono w-12 text-right">{total}</span>
              </button>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('telemetry:quality.recent.title', { classifier: selected })}</CardTitle></CardHeader>
        <CardContent className="space-y-1 max-h-96 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">{t('telemetry:quality.recent.empty')}</div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-xs border-b py-1 last:border-b-0">
                <span className="font-mono text-muted-foreground w-20">{r.created_at.slice(11, 19)}</span>
                <Badge className={VERDICT_COLOR[r.verdict] + ' text-white'}>{verdictLabel[r.verdict]}</Badge>
                <span className="flex-1 truncate" title={r.reason ?? ''}>{r.reason ?? '—'}</span>
                {r.confidence != null && <Badge variant="outline">{Math.round(r.confidence * 100)}%</Badge>}
                <span className="font-mono text-xs">{r.model_id ?? '?'}</span>
                {r.latency_ms != null && <span className="font-mono text-xs">{Math.round(r.latency_ms)}ms</span>}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {interventionStats && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('telemetry:quality.interventions.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {lift && (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span
                  className={`text-2xl font-semibold ${
                    lift.pp > 0 ? 'text-emerald-500' : lift.pp < 0 ? 'text-red-500' : ''
                  }`}
                >
                  {lift.pp >= 0 ? '+' : ''}{Math.round(lift.pp * 100)} pp
                </span>
                <span className="text-xs font-medium">{t('telemetry:quality.interventions.lift')}</span>
                <span className="text-xs text-muted-foreground">
                  · {t('telemetry:quality.interventions.liftHint', { nudge: lift.nudge, holdout: lift.holdout })}
                </span>
              </div>
            )}
            {interventionStats.byType.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                {t('telemetry:quality.interventions.empty')}
              </div>
            ) : (
              <div className="space-y-2">
                {interventionStats.byType.map((row) => {
                  const total = row.improved + row.unchanged + row.worsened + row.pending;
                  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
                  const improvedPct = row.measured > 0
                    ? `${Math.round(row.improved_rate * 100)}%`
                    : '—';
                  return (
                    <div key={row.intervention_type} className="space-y-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono w-36" title={row.intervention_type}>{typeLabel(row.intervention_type)}</span>
                        <div className="flex-1 h-4 rounded bg-muted overflow-hidden flex">
                          <div className="h-full bg-emerald-500" style={{ width: `${pct(row.improved)}%` }} title={`${t('telemetry:quality.interventions.improved')}: ${row.improved}`} />
                          <div className="h-full bg-slate-400"   style={{ width: `${pct(row.unchanged)}%` }} title={`${t('telemetry:quality.interventions.unchanged')}: ${row.unchanged}`} />
                          <div className="h-full bg-red-500"     style={{ width: `${pct(row.worsened)}%` }} title={`${t('telemetry:quality.interventions.worsened')}: ${row.worsened}`} />
                          <div className="h-full bg-muted-foreground/30" style={{ width: `${pct(row.pending)}%` }} title={`${t('telemetry:quality.interventions.pending')}: ${row.pending}`} />
                        </div>
                        <Badge variant="outline" className="text-xs font-mono">
                          {t('telemetry:quality.interventions.improvedRate')}: {improvedPct}
                        </Badge>
                        <span className="font-mono text-xs w-12 text-right">{total}</span>
                      </div>
                    </div>
                  );
                })}
                <div className="pt-2 border-t flex gap-3 text-[11px] text-muted-foreground">
                  <Legend color="bg-emerald-500" label={t('telemetry:quality.interventions.improved')} />
                  <Legend color="bg-slate-400" label={t('telemetry:quality.interventions.unchanged')} />
                  <Legend color="bg-red-500" label={t('telemetry:quality.interventions.worsened')} />
                  <Legend color="bg-muted-foreground/30" label={t('telemetry:quality.interventions.pending')} />
                </div>
              </div>
            )}
            {interventionStats.recent.length > 0 && (
              <div className="pt-2 border-t space-y-1 max-h-60 overflow-y-auto">
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  {t('telemetry:quality.interventions.recentTitle')}
                </div>
                {interventionStats.recent.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-xs border-b py-1 last:border-b-0">
                    <span className="font-mono text-muted-foreground w-20">{r.created_at.slice(11, 19)}</span>
                    <Badge variant="outline" className="font-mono" title={r.intervention_type}>{typeLabel(r.intervention_type)}</Badge>
                    <span className="font-mono text-xs">turn {r.turn_fired}</span>
                    <span className="font-mono text-xs text-muted-foreground truncate flex-1">
                      {r.triggering_classifiers || '—'}
                    </span>
                    {r.outcome && (
                      <Badge className={outcomeBadgeClass(r.outcome) + ' text-white'}>
                        {t(`telemetry:quality.interventions.${r.outcome}`)}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {cfStats && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{t('telemetry:quality.shadow.title')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <div className="text-xs text-muted-foreground">{t('telemetry:quality.shadow.totalRows')}</div>
                <div className="text-2xl font-semibold">{cfStats.totalRows}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('telemetry:quality.shadow.withOutcome')}</div>
                <div className="text-2xl font-semibold">{cfStats.withOutcome}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('telemetry:quality.shadow.pendingOutcome')}</div>
                <div className="text-2xl font-semibold">{cfStats.pendingOutcome}</div>
              </div>
            </div>
            {cfStats.perVariant.length > 0 && (
              <div className="space-y-1 pt-2 border-t">
                {cfStats.perVariant.map((v) => (
                  <div key={`${v.pipeline_name}::${v.shadow_variant}`} className="flex items-center gap-2 text-xs">
                    <span className="font-mono">{v.pipeline_name}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="font-mono">{v.shadow_variant}</span>
                    <span className="flex-1" />
                    <Badge variant="outline">{t('telemetry:quality.shadow.rowsBadge', { count: v.count })}</Badge>
                    <Badge>{t('telemetry:quality.shadow.withOutcomeBadge', { count: v.with_outcome })}</Badge>
                  </div>
                ))}
              </div>
            )}
            {cfStats.totalRows === 0 && (
              <div className="text-xs text-muted-foreground italic">
                {t('telemetry:quality.shadow.empty')}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Quality v2, C5 — Small legend swatch reused by the intervention card.
 * Kept local because no other panel currently shows a 4-color legend.
 */
function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${color}`} />
      <span>{label}</span>
    </span>
  );
}

/**
 * Map an intervention outcome to a tailwind background class. Mirrors
 * `VERDICT_COLOR` but for the outcome axis (improved/worsened/pending).
 * 'pending' is intentionally muted so it doesn't draw attention until
 * the backfill fires.
 */
function outcomeBadgeClass(outcome: 'improved' | 'unchanged' | 'worsened' | 'pending'): string {
  switch (outcome) {
    case 'improved':  return 'bg-emerald-500';
    case 'worsened':  return 'bg-red-500';
    case 'unchanged': return 'bg-slate-400';
    case 'pending':   return 'bg-muted-foreground/60';
  }
}
