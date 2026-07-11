import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, DollarSign, Info, Loader2, Scissors } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { cn } from '../../lib/utils.js';
import { QualityPanel } from '../admin/QualityPanel.js';
import { SupervisorPanel } from '../admin/SupervisorPanel.js';
import { CompletionQualityPanel } from './CompletionQualityPanel.js';
import { SINCE_PRESETS, sinceForKey } from './since.js';
import { TelemetryCoverageNote, type TelemetryCoverage } from './TelemetryCoverageNote.js';
import { ModelPricesPanel } from './ModelPricesPanel.js';

interface ProviderRow {
  provider: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

interface ModelRow {
  model: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
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
  estimated_cost_usd: number;
  last_turn_at: string | null;
}

interface SkillsModeRow {
  mode: string;
  sessions: number;
}

interface TopToolRow {
  name: string;
  calls: number;
  total_output_chars: number;
  avg_duration_ms: number;
  truncated_count: number;
}

interface PhaseRow {
  phase: string;
  tool_calls: number;
  total_output_chars: number;
  total_duration_ms: number;
}

interface GuardRolloutRow {
  repeat_policy: string;
  execution_class: string;
  candidates: number;
  delivered_candidates: number;
  confirmed_redundant: number;
  false_block_signals: number;
  precision: number;
  confidence_lower_bound: number;
  false_block_rate: number;
  target_candidates: number;
  eligible_for_enforcement: boolean;
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
    total_estimated_cost_usd: number;
    truncation_rate: number | null;
  };
  coverage: TelemetryCoverage;
  by_provider: ProviderRow[];
  by_model: ModelRow[];
  skills_modes: SkillsModeRow[];
  top_tools: TopToolRow[];
  guard_rollout?: GuardRolloutRow[];
  phase_breakdown: PhaseRow[];
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

function formatUsd(value: number): string {
  if (!isFinite(value) || value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value < 1) return `$${value.toFixed(2)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  if (value < 10_000) return `$${value.toFixed(0)}`;
  return `$${(value / 1000).toFixed(1)}k`;
}


interface ProjectOption { id: number; name: string }

/**
 * Top-level `/telemetry` page.
 *
 * Previously a flat "session telemetry" dashboard, now wrapped in tabs so
 * the panels that used to live in the admin tray (quality classifiers,
 * agent supervisor) live next to the global stats they relate to.
 * Operators land here when they want observability — every dashboard-shaped
 * panel is one click away instead of spread between `/admin` and `/telemetry`.
 *
 * The shell mirrors `/docs` (DocsPage): a compact top band (title + info
 * tooltip + lightweight tabs) over a body that fills the height and scrolls.
 *
 * Tab list:
 *   - overview   : global session stats (cost, tokens, top tools)
 *   - prices     : per-model price table + sync/backfill
 *   - quality    : 5-classifier verdict distribution + counterfactual stats
 *   - completion : AI ghost-text quality (accept rate, latency, per-model)
 *   - supervisor : live AgentSupervisor status + incidents
 */
const TELEMETRY_TABS = ['overview', 'prices', 'quality', 'completion', 'supervisor'] as const;

export function TelemetryDashboard() {
  const { t } = useTranslation(['telemetry', 'common']);
  return (
    // Full-height IDE-style shell, mirroring `/docs` (DocsPage): the title,
    // an info affordance (description on hover) and the tabs share one
    // compact top band; the active tab's body fills the rest and scrolls on
    // its own. `/telemetry` opts out of AppShell's outer scroll+padding (see
    // AppShell), so this owns its height — `min-h-0` is load-bearing.
    <Tabs defaultValue="overview" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 px-3 h-11 border-b shrink-0">
        <Activity className="h-4 w-4 text-primary shrink-0" />
        <span className="text-[13px] font-semibold shrink-0">{t('telemetry:title')}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('telemetry:aboutAria')}
              className="text-muted-foreground/70 hover:text-foreground transition-colors shrink-0"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm leading-relaxed">
            {t('telemetry:subtitle')}
          </TooltipContent>
        </Tooltip>

        <div className="mx-1 h-4 w-px bg-border shrink-0" />

        <TabsList className="h-auto gap-0.5 bg-transparent p-0">
          {TELEMETRY_TABS.map((id) => (
            <TabsTrigger
              key={id}
              value={id}
              className={cn(
                'h-7 rounded px-2 text-xs font-medium text-muted-foreground shadow-none',
                'hover:text-foreground hover:bg-muted',
                'data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none',
              )}
            >
              {t(`telemetry:tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </header>

      <TabsContent value="overview" className="flex-1 min-h-0 mt-0 overflow-y-auto px-4 pb-4">
        <div className="pt-3">
          <TelemetryOverview />
        </div>
      </TabsContent>

      <TabsContent value="prices" className="flex-1 min-h-0 mt-0 overflow-y-auto px-4 pb-4">
        <div className="pt-3">
          <ModelPricesPanel />
        </div>
      </TabsContent>

      <TabsContent value="quality" className="flex-1 min-h-0 mt-0 overflow-y-auto px-4 pb-4">
        <div className="pt-3">
          <QualityPanel />
        </div>
      </TabsContent>

      <TabsContent value="completion" className="flex-1 min-h-0 mt-0 overflow-y-auto px-4 pb-4">
        <div className="pt-3">
          <CompletionQualityPanel />
        </div>
      </TabsContent>

      <TabsContent value="supervisor" className="flex-1 min-h-0 mt-0 overflow-y-auto px-4 pb-4">
        <div className="pt-3">
          <SupervisorPanel variant="dashboard" />
        </div>
      </TabsContent>
    </Tabs>
  );
}

/**
 * Original `/telemetry` flat-page content, kept verbatim — overall session
 * stats with project + since filters. Lives as a sibling tab to the
 * pipeline / quality panels above.
 */
function TelemetryOverview() {
  const { t } = useTranslation(['telemetry', 'common']);
  const [projectId, setProjectId] = useState<number | 'all'>('all');
  const [sinceKey, setSinceKey] = useState<string>('all');
  const sinceParam = sinceForKey(sinceKey);
  const params = new URLSearchParams();
  if (projectId !== 'all') params.set('project_id', String(projectId));
  if (sinceParam) params.set('since', sinceParam);
  const qs = params.toString();
  const url = qs ? `/admin/telemetry/global?${qs}` : '/admin/telemetry/global';
  const { data, loading, error } = useApi<GlobalTelemetry>(url);
  // Project list for the filter — best-effort: if the endpoint isn't
  // available the dropdown still renders with just "All projects".
  const { data: projectList } = useApi<{ projects: ProjectOption[] }>('/projects');

  return (
    <div className="space-y-4">
      {/* Filters: project + since. Both rebind to the same URL — the API
          serves filtered aggregations natively (migration 072). */}
      <div className="flex flex-wrap gap-2 text-xs">
        <select
          className="rounded border bg-background px-2 py-1"
          value={projectId === 'all' ? 'all' : String(projectId)}
          onChange={(e) => setProjectId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
        >
          <option value="all">{t('telemetry:filters.allProjects')}</option>
          {(projectList?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="inline-flex rounded border overflow-hidden">
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
            <StatCard
              icon={<DollarSign className="h-3 w-3" />}
              label={t('telemetry:overall.cost')}
              value={formatUsd(data.overall.total_estimated_cost_usd)}
            />
            <StatCard
              icon={<Scissors className="h-3 w-3" />}
              label={t('telemetry:overall.truncation')}
              value={formatPct(data.overall.truncation_rate)}
              intent={
                data.overall.truncation_rate !== null && data.overall.truncation_rate >= 0.2
                  ? 'warn'
                  : undefined
              }
            />
          </div>

          <TelemetryCoverageNote coverage={data.coverage} />

          {/* Top tools (migration 072) — by output_chars produced. */}
          {data.top_tools && data.top_tools.length > 0 && (
            <div className="rounded-md border bg-card/50">
              <div className="px-3 py-2 border-b text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('telemetry:topTools.title')}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">{t('telemetry:topTools.name')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:topTools.calls')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:topTools.outputChars')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:topTools.avgDuration')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:topTools.truncated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_tools.slice(0, 15).map((r) => (
                      <tr key={r.name} className="border-t hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono">{r.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.calls}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatK(r.total_output_chars)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.avg_duration_ms}ms</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${r.truncated_count > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                          {r.truncated_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.guard_rollout && data.guard_rollout.length > 0 && (
            <div className="rounded-md border bg-card/50">
              <div className="px-3 py-2 border-b">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('telemetry:guardRollout.title')}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {t('telemetry:guardRollout.subtitle')}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">{t('telemetry:guardRollout.class')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:guardRollout.candidates')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:guardRollout.precision')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:guardRollout.lowerBound')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:guardRollout.falseBlock')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('telemetry:guardRollout.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.guard_rollout.map((row) => (
                      <tr key={`${row.repeat_policy}:${row.execution_class}`} className="border-t hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono">{row.repeat_policy}/{row.execution_class}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {row.candidates}/{row.target_candidates}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPct(row.precision)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPct(row.confidence_lower_bound)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPct(row.false_block_rate)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium',
                            row.eligible_for_enforcement
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              : 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
                          )}>
                            {t(row.eligible_for_enforcement
                              ? 'telemetry:guardRollout.eligible'
                              : 'telemetry:guardRollout.observing')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Phase breakdown (Camada 2 — empty until PhaseRouter ships). */}
          {data.phase_breakdown && data.phase_breakdown.length > 0 && (
            <div className="rounded-md border bg-card/50">
              <div className="px-3 py-2 border-b text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('telemetry:phaseBreakdown.title')}
              </div>
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">{t('telemetry:phaseBreakdown.phase')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('telemetry:phaseBreakdown.calls')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('telemetry:phaseBreakdown.outputChars')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('telemetry:phaseBreakdown.totalDuration')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.phase_breakdown.map((r) => (
                    <tr key={r.phase} className="border-t hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono">{r.phase}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.tool_calls}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatK(r.total_output_chars)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.total_duration_ms}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.phase_breakdown.length === 1 && data.phase_breakdown[0].phase === 'unknown' && (
                <div className="px-3 py-2 text-[11px] text-muted-foreground border-t">
                  {t('telemetry:phaseBreakdown.notRoutedYet')}
                </div>
              )}
            </div>
          )}

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
                cost: r.estimated_cost_usd,
              }))}
              tHeader={{
                label: t('telemetry:byProvider.label'),
                turns: t('telemetry:byProvider.turns'),
                input: t('telemetry:byProvider.input'),
                output: t('telemetry:byProvider.output'),
                cost: t('telemetry:byProvider.cost'),
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
                cost: r.estimated_cost_usd,
              }))}
              tHeader={{
                label: t('telemetry:byModel.label'),
                turns: t('telemetry:byModel.turns'),
                input: t('telemetry:byModel.input'),
                output: t('telemetry:byModel.output'),
                cost: t('telemetry:byModel.cost'),
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
                    <th className="px-3 py-2 text-right font-medium">{t('telemetry:topSessions.cost')}</th>
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
                      <td className="px-3 py-2 text-right tabular-nums">{formatUsd(s.estimated_cost_usd)}</td>
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

function StatCard({ label, value, intent, icon }: { label: string; value: string; intent?: 'good' | 'warn'; icon?: React.ReactNode }) {
  const valueClass =
    intent === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : intent === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : '';
  return (
    <div className="rounded-md border bg-card/50 p-3 flex flex-col">
      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">{icon}{label}</span>
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
  cost?: number;
}

function BreakdownTable({
  title,
  rows,
  tHeader,
}: {
  title: string;
  rows: BreakdownRow[];
  tHeader: { label: string; turns: string; input: string; output: string; cost?: string };
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
              {tHeader.cost && <th className="px-3 py-2 text-right font-medium">{tHeader.cost}</th>}
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
                  {tHeader.cost && (
                    <td className="px-3 py-2 text-right tabular-nums">{formatUsd(r.cost ?? 0)}</td>
                  )}
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
