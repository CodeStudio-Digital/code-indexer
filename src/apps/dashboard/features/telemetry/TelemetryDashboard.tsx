import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, Loader2 } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';

interface ProviderRow {
  provider: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
}

interface ModelRow {
  model: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
}

interface TopSession {
  session_id: number | null;
  title: string | null;
  provider: string | null;
  model: string | null;
  turn_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cache_hit_ratio: number | null;
  last_turn_at: string | null;
}

interface SkillsModeRow {
  mode: string;
  sessions: number;
}

interface GlobalTelemetry {
  overall: {
    session_count: number;
    turn_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    cache_hit_ratio: number | null;
    compaction_turns: number;
    paginate_total: number;
  };
  by_provider: ProviderRow[];
  by_model: ModelRow[];
  skills_modes: SkillsModeRow[];
  top_sessions: TopSession[];
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatPct(ratio: number | null): string {
  if (ratio === null || !isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export function TelemetryDashboard() {
  const { t } = useTranslation(['telemetry', 'common']);
  const { data, loading, error } = useApi<GlobalTelemetry>('/admin/telemetry/global');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="h-5 w-5" />
        <h1 className="text-lg font-semibold">{t('telemetry:title')}</h1>
      </div>
      <p className="text-sm text-muted-foreground">{t('telemetry:subtitle')}</p>

      {loading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {error && !loading && (
        <div className="text-sm text-red-500 p-4 border border-red-500/30 rounded-md bg-red-500/5">
          {error}
        </div>
      )}
      {data && !loading && data.overall.turn_count === 0 && (
        <div className="text-sm text-muted-foreground p-6 border rounded-md bg-card/50 text-center">
          {t('telemetry:empty')}
        </div>
      )}
      {data && !loading && data.overall.turn_count > 0 && (
        <>
          {/* Overall stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={t('telemetry:overall.sessions')} value={String(data.overall.session_count)} />
            <StatCard label={t('telemetry:overall.turns')} value={String(data.overall.turn_count)} />
            <StatCard label={t('telemetry:overall.inputTokens')} value={formatK(data.overall.total_input_tokens)} />
            <StatCard label={t('telemetry:overall.outputTokens')} value={formatK(data.overall.total_output_tokens)} />
            <StatCard label={t('telemetry:overall.cacheRead')} value={formatK(data.overall.total_cache_read_tokens)} />
            <StatCard
              label={t('telemetry:overall.cacheHit')}
              value={formatPct(data.overall.cache_hit_ratio)}
              intent={
                data.overall.cache_hit_ratio !== null && data.overall.cache_hit_ratio >= 0.6
                  ? 'good'
                  : data.overall.cache_hit_ratio !== null && data.overall.cache_hit_ratio < 0.3
                    ? 'warn'
                    : undefined
              }
            />
            <StatCard label={t('telemetry:overall.compaction')} value={String(data.overall.compaction_turns)} />
            <StatCard
              label={t('telemetry:overall.paginate')}
              value={String(data.overall.paginate_total)}
              intent={data.overall.paginate_total > 0 ? 'warn' : undefined}
            />
          </div>

          {/* Provider + model breakdowns */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <BreakdownTable
              title={t('telemetry:byProvider.title')}
              rows={data.by_provider.map((r) => ({
                key: r.provider,
                label: r.provider,
                turns: r.turns,
                input: r.input_tokens,
                output: r.output_tokens,
              }))}
              tHeader={{
                label: t('telemetry:byProvider.label'),
                turns: t('telemetry:byProvider.turns'),
                input: t('telemetry:byProvider.input'),
                output: t('telemetry:byProvider.output'),
              }}
            />
            <BreakdownTable
              title={t('telemetry:byModel.title')}
              rows={data.by_model.map((r) => ({
                key: r.model,
                label: r.model,
                turns: r.turns,
                input: r.input_tokens,
                output: r.output_tokens,
              }))}
              tHeader={{
                label: t('telemetry:byModel.label'),
                turns: t('telemetry:byModel.turns'),
                input: t('telemetry:byModel.input'),
                output: t('telemetry:byModel.output'),
              }}
            />
          </div>

          {/* Skills mode adoption */}
          {data.skills_modes && data.skills_modes.length > 0 && (
            <div className="rounded-md border bg-card/50">
              <div className="px-3 py-2 border-b text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('telemetry:skillsModes.title')}
              </div>
              <div className="px-3 py-2 flex flex-wrap gap-2 text-xs">
                {data.skills_modes.map((m) => (
                  <span key={m.mode} className={`px-2 py-1 rounded font-mono ${skillsModeBadge(m.mode)}`}>
                    {m.mode}: {m.sessions}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Top sessions */}
          <div className="rounded-md border bg-card/50">
            <div className="px-3 py-2 border-b text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('telemetry:topSessions.title')}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">{t('telemetry:topSessions.session')}</th>
                    <th className="px-3 py-2 font-medium">{t('telemetry:topSessions.providerModel')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('telemetry:topSessions.turns')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('telemetry:topSessions.input')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('telemetry:topSessions.output')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('telemetry:topSessions.cache')}</th>
                    <th className="px-3 py-2 font-medium">{t('telemetry:topSessions.lastTurn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_sessions.map((s) => (
                    <tr key={s.session_id ?? Math.random()} className="border-t hover:bg-muted/20">
                      <td className="px-3 py-2 font-medium truncate max-w-xs">
                        {s.title ?? `#${s.session_id ?? '?'}`}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {s.provider ?? '—'}
                        {s.model ? ` / ${s.model}` : ''}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.turn_count}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatK(s.total_input_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatK(s.total_output_tokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatPct(s.cache_hit_ratio)}</td>
                      <td className="px-3 py-2 text-muted-foreground text-[11px]">
                        {s.last_turn_at ? new Date(s.last_turn_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {data.overall.paginate_total > 0 && (
            <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 p-3 border border-amber-500/30 rounded-md bg-amber-500/5">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>{t('telemetry:warnings.paginate', { count: data.overall.paginate_total })}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function skillsModeBadge(mode: string): string {
  switch (mode) {
    case 'lazy':
    case 'matched':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
    case 'compact':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-400';
    case 'full':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
    case 'none':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function StatCard({ label, value, intent }: { label: string; value: string; intent?: 'good' | 'warn' }) {
  const valueClass =
    intent === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : intent === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : '';
  return (
    <div className="rounded-md border bg-card/50 p-3 flex flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

interface BreakdownRow {
  key: string;
  label: string;
  turns: number;
  input: number;
  output: number;
}

function BreakdownTable({
  title,
  rows,
  tHeader,
}: {
  title: string;
  rows: BreakdownRow[];
  tHeader: { label: string; turns: string; input: string; output: string };
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.input), 0);
  return (
    <div className="rounded-md border bg-card/50">
      <div className="px-3 py-2 border-b text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">—</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">{tHeader.label}</th>
              <th className="px-3 py-2 text-right font-medium">{tHeader.turns}</th>
              <th className="px-3 py-2 text-right font-medium">{tHeader.input}</th>
              <th className="px-3 py-2 text-right font-medium">{tHeader.output}</th>
              <th className="px-3 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = max > 0 ? Math.round((r.input / max) * 100) : 0;
              return (
                <tr key={r.key} className="border-t hover:bg-muted/20">
                  <td className="px-3 py-2 font-medium">{r.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.turns}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatK(r.input)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatK(r.output)}</td>
                  <td className="px-3 py-2">
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
