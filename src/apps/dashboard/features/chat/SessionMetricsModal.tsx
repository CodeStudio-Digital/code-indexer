import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Activity, AlertTriangle, BarChart3, ChevronDown, ChevronRight, Database, DollarSign, FileText, History, Loader2, Scissors, Wrench } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { useApi } from '../../hooks/useApi.js';

interface ToolBreakdown {
  name: string;
  calls: number;
  total_output_chars: number;
  avg_duration_ms: number;
  truncated_count: number;
}

interface PhaseBreakdown {
  phase: string;
  tool_calls: number;
  total_output_chars: number;
  total_duration_ms: number;
}

interface FirstTurnPayload {
  system_prompt_chars: number | null;
  tools_array_chars: number | null;
  tools_count: number | null;
  first_turn_input_tokens: number | null;
  first_turn_output_tokens: number | null;
  estimated_chars_per_token: number;
  skills_mode: string | null;
  skills_count: number | null;
}

interface TurnRow {
  id: number;
  turn: number;
  is_subagent: number;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  thinking_tokens: number | null;
  history_chars: number | null;
  tool_count: number;
  tools_called_json: string | null;
  largest_tool_result_chars: number | null;
  compaction_triggered: number;
  summarizer_ran: number;
  paginate_count: number;
  created_at: string;
}

interface SessionTelemetrySummary {
  turn_count: number;
  subagent_turn_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_thinking_tokens: number;
  cache_hit_ratio: number | null;
  total_tool_calls: number;
  compaction_turns: number;
  summarizer_turns: number;
  paginate_total: number;
  largest_tool_result_chars: number | null;
  last_history_chars: number | null;
  last_turn_at: string | null;
  tools_breakdown: ToolBreakdown[];
  first_turn_payload: FirstTurnPayload;
  turns: TurnRow[];
  /** Migration 072. */
  estimated_cost_usd: number;
  /** Migration 072 — average across assistant turns. */
  system_prompt_avg_chars: number | null;
  /** Migration 072 — average across assistant turns. */
  tools_def_avg_chars: number | null;
  /** Migration 072. */
  truncation_rate: number | null;
  /** Migration 072 — populated by Camada 2 (PhaseRouter). */
  phase_breakdown: PhaseBreakdown[];
}

interface SessionMetricsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number | null;
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

export function SessionMetricsModal({ open, onOpenChange, sessionId }: SessionMetricsModalProps) {
  const { t } = useTranslation(['chat', 'common']);
  const url = open && sessionId ? `/sessions/${sessionId}/telemetry` : '';
  const { data, loading, error } = useApi<SessionTelemetrySummary>(url);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            {t('chat:metrics.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4 pr-1">
          {loading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {error && !loading && (
            <div className="text-sm text-red-500 p-4">{error}</div>
          )}
          {data && !loading && data.turn_count === 0 && (
            <div className="text-sm text-muted-foreground p-4">{t('chat:metrics.empty')}</div>
          )}
          {data && !loading && data.turn_count > 0 && (
            <>
              {/* Token totals */}
              <Section title={t('chat:metrics.tokens.title')} icon={<BarChart3 className="h-3.5 w-3.5" />}>
                <Stat label={t('chat:metrics.tokens.input')} value={formatK(data.total_input_tokens)} />
                <Stat label={t('chat:metrics.tokens.output')} value={formatK(data.total_output_tokens)} />
                <Stat label={t('chat:metrics.tokens.cacheRead')} value={formatK(data.total_cache_read_tokens)} />
                <Stat label={t('chat:metrics.tokens.cacheCreation')} value={formatK(data.total_cache_creation_tokens)} />
                <Stat label={t('chat:metrics.tokens.thinking')} value={formatK(data.total_thinking_tokens)} />
                <Stat
                  label={t('chat:metrics.tokens.cacheHit')}
                  value={formatPct(data.cache_hit_ratio)}
                  intent={
                    data.cache_hit_ratio !== null && data.cache_hit_ratio >= 0.6
                      ? 'good'
                      : data.cache_hit_ratio !== null && data.cache_hit_ratio < 0.3 && data.turn_count >= 4
                        ? 'warn'
                        : undefined
                  }
                />
              </Section>

              {/* Cost & bloat (migration 072) */}
              <Section title={t('chat:metrics.cost.title')} icon={<DollarSign className="h-3.5 w-3.5" />}>
                <Stat label={t('chat:metrics.cost.estimatedUsd')} value={formatUsd(data.estimated_cost_usd)} />
                <Stat
                  label={t('chat:metrics.cost.systemPromptAvg')}
                  value={data.system_prompt_avg_chars != null ? `${formatK(Math.round(data.system_prompt_avg_chars))} ch` : '—'}
                  intent={
                    data.system_prompt_avg_chars != null && data.system_prompt_avg_chars > 8_000
                      ? 'warn'
                      : undefined
                  }
                />
                <Stat
                  label={t('chat:metrics.cost.toolsDefAvg')}
                  value={data.tools_def_avg_chars != null ? `${formatK(Math.round(data.tools_def_avg_chars))} ch` : '—'}
                  intent={
                    data.tools_def_avg_chars != null && data.tools_def_avg_chars > 15_000
                      ? 'warn'
                      : undefined
                  }
                />
                <Stat
                  label={t('chat:metrics.cost.truncation')}
                  value={formatPct(data.truncation_rate)}
                  intent={
                    data.truncation_rate !== null && data.truncation_rate >= 0.2 ? 'warn' : undefined
                  }
                />
              </Section>

              {/* Turns + context signals */}
              <Section title={t('chat:metrics.turns.title')} icon={<Database className="h-3.5 w-3.5" />}>
                <Stat label={t('chat:metrics.turns.count')} value={String(data.turn_count)} />
                <Stat label={t('chat:metrics.turns.subagent')} value={String(data.subagent_turn_count)} />
                <Stat label={t('chat:metrics.turns.compaction')} value={String(data.compaction_turns)} />
                <Stat label={t('chat:metrics.turns.summarizer')} value={String(data.summarizer_turns)} />
                <Stat
                  label={t('chat:metrics.turns.paginate')}
                  value={String(data.paginate_total)}
                  intent={data.paginate_total > 0 ? 'warn' : undefined}
                />
                <Stat
                  label={t('chat:metrics.turns.largestResult')}
                  value={data.largest_tool_result_chars !== null ? formatK(data.largest_tool_result_chars) : '—'}
                />
              </Section>

              {/* First-turn payload breakdown (diagnostic) */}
              {data.first_turn_payload && (
                <FirstTurnBreakdown payload={data.first_turn_payload} t={t} />
              )}

              {/* Tools breakdown — migration 072 enriches with output/duration/truncation. */}
              <Section title={t('chat:metrics.tools.title')} icon={<Wrench className="h-3.5 w-3.5" />}>
                {data.tools_breakdown.length === 0 ? (
                  <div className="col-span-full text-sm text-muted-foreground">
                    {t('chat:metrics.tools.empty')}
                  </div>
                ) : (
                  <div className="col-span-full">
                    <table className="w-full text-xs">
                      <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        <tr className="text-left">
                          <th className="font-normal py-1">{t('chat:metrics.tools.name')}</th>
                          <th className="font-normal py-1 text-right">{t('chat:metrics.tools.calls')}</th>
                          <th className="font-normal py-1 text-right">{t('chat:metrics.tools.outputChars')}</th>
                          <th className="font-normal py-1 text-right">{t('chat:metrics.tools.avgDuration')}</th>
                          <th className="font-normal py-1 text-right">{t('chat:metrics.tools.truncated')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.tools_breakdown.map((row) => (
                          <tr key={row.name} className="border-t">
                            <td className="font-mono text-[11px] py-1 truncate max-w-[220px]" title={row.name}>{row.name}</td>
                            <td className="text-right tabular-nums py-1">{row.calls}</td>
                            <td className="text-right tabular-nums py-1">{formatK(row.total_output_chars)}</td>
                            <td className="text-right tabular-nums py-1 text-muted-foreground">{row.avg_duration_ms}ms</td>
                            <td className={`text-right tabular-nums py-1 ${row.truncated_count > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                              {row.truncated_count || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              {/* Phase breakdown — empty (`unknown`) until Camada 2 ships PhaseRouter. */}
              {data.phase_breakdown && data.phase_breakdown.length > 0 && (
                <Section title={t('chat:metrics.phase.title')} icon={<Scissors className="h-3.5 w-3.5" />}>
                  <div className="col-span-full">
                    {data.phase_breakdown.length === 1 && data.phase_breakdown[0].phase === 'unknown' ? (
                      <div className="text-[11px] text-muted-foreground">
                        {t('chat:metrics.phase.notRoutedYet')}
                      </div>
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          <tr className="text-left">
                            <th className="font-normal py-1">{t('chat:metrics.phase.phase')}</th>
                            <th className="font-normal py-1 text-right">{t('chat:metrics.phase.calls')}</th>
                            <th className="font-normal py-1 text-right">{t('chat:metrics.phase.outputChars')}</th>
                            <th className="font-normal py-1 text-right">{t('chat:metrics.phase.totalDuration')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.phase_breakdown.map((row) => (
                            <tr key={row.phase} className="border-t">
                              <td className="font-mono text-[11px] py-1">{row.phase}</td>
                              <td className="text-right tabular-nums py-1">{row.tool_calls}</td>
                              <td className="text-right tabular-nums py-1">{formatK(row.total_output_chars)}</td>
                              <td className="text-right tabular-nums py-1 text-muted-foreground">{row.total_duration_ms}ms</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </Section>
              )}

              {/* Per-turn timeline */}
              {data.turns && data.turns.length > 0 && (
                <TurnsTimeline turns={data.turns} t={t} />
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-card/50 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
        {icon}
        {title}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{children}</div>
    </div>
  );
}

function Stat({ label, value, intent }: { label: string; value: string; intent?: 'good' | 'warn' }) {
  const valueClass =
    intent === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : intent === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : '';
  return (
    <div className="flex flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

function FirstTurnBreakdown({
  payload,
  t,
}: {
  payload: FirstTurnPayload;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  const sysChars = payload.system_prompt_chars ?? 0;
  const toolsChars = payload.tools_array_chars ?? 0;
  const cpt = payload.estimated_chars_per_token || 4;
  const sysTokensEst = Math.round(sysChars / cpt);
  const toolsTokensEst = Math.round(toolsChars / cpt);
  const inputTokens = payload.first_turn_input_tokens ?? 0;
  const accountedTokens = sysTokensEst + toolsTokensEst;
  const otherTokens = Math.max(0, inputTokens - accountedTokens);
  const total = Math.max(1, inputTokens);

  const sysPct = Math.round((sysTokensEst / total) * 100);
  const toolsPct = Math.round((toolsTokensEst / total) * 100);
  const otherPct = Math.max(0, 100 - sysPct - toolsPct);

  return (
    <div className="rounded-md border bg-card/50 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
        <FileText className="h-3.5 w-3.5" />
        {t('chat:metrics.payload.title')}
      </div>
      <div className="text-[11px] text-muted-foreground mb-2">
        {t('chat:metrics.payload.subtitle', { tokens: inputTokens })}
      </div>
      {/* Stacked bar */}
      {inputTokens > 0 && (
        <div className="flex h-2 rounded-full overflow-hidden bg-muted mb-2">
          <div className="bg-primary" style={{ width: `${sysPct}%` }} title={`system ${sysPct}%`} />
          <div className="bg-amber-500" style={{ width: `${toolsPct}%` }} title={`tools ${toolsPct}%`} />
          <div className="bg-muted-foreground/40" style={{ width: `${otherPct}%` }} title={`other ${otherPct}%`} />
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <PayloadBreakdownItem
          color="bg-primary"
          label={t('chat:metrics.payload.system')}
          chars={sysChars}
          tokensEst={sysTokensEst}
          pct={inputTokens > 0 ? sysPct : null}
        />
        <PayloadBreakdownItem
          color="bg-amber-500"
          label={t('chat:metrics.payload.tools', { count: payload.tools_count ?? 0 })}
          chars={toolsChars}
          tokensEst={toolsTokensEst}
          pct={inputTokens > 0 ? toolsPct : null}
        />
        <PayloadBreakdownItem
          color="bg-muted-foreground/40"
          label={t('chat:metrics.payload.other')}
          chars={null}
          tokensEst={otherTokens}
          pct={inputTokens > 0 ? otherPct : null}
        />
      </div>
      {payload.skills_mode && (
        <div className="mt-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
          <span className="font-medium">{t('chat:metrics.payload.skillsMode')}:</span>
          <span className={skillsModeColor(payload.skills_mode)}>{payload.skills_mode}</span>
          {payload.skills_count !== null && (
            <span>· {payload.skills_count} {t('chat:metrics.payload.skillsAvailable')}</span>
          )}
        </div>
      )}
      {sysTokensEst + toolsTokensEst > 4_000 && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          {t('chat:metrics.payload.heavyHint')}
        </div>
      )}
    </div>
  );
}

function skillsModeColor(mode: string): string {
  switch (mode) {
    case 'lazy': return 'text-emerald-600 dark:text-emerald-400 font-mono';
    case 'matched': return 'text-emerald-600 dark:text-emerald-400 font-mono';
    case 'compact': return 'text-blue-600 dark:text-blue-400 font-mono';
    case 'full': return 'text-amber-600 dark:text-amber-400 font-mono';
    case 'none': return 'text-muted-foreground font-mono';
    default: return 'text-muted-foreground font-mono';
  }
}

function PayloadBreakdownItem({
  color,
  label,
  chars,
  tokensEst,
  pct,
}: {
  color: string;
  label: string;
  chars: number | null;
  tokensEst: number;
  pct: number | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${color}`} />
        <span className="text-[11px] text-muted-foreground truncate">{label}</span>
      </div>
      <span className="text-sm font-medium tabular-nums">
        {pct !== null ? `${pct}%` : '—'}
      </span>
      <span className="text-[10px] text-muted-foreground tabular-nums">
        ~{tokensEst.toLocaleString()} tok
        {chars !== null ? ` · ${chars.toLocaleString()} ch` : ''}
      </span>
    </div>
  );
}

function TurnsTimeline({
  turns,
  t,
}: {
  turns: TurnRow[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  const [allOpen, setAllOpen] = useState(false);
  // Compute max input across all turns so per-turn bars share a scale.
  const maxInput = turns.reduce((m, r) => Math.max(m, r.input_tokens ?? 0), 0);

  return (
    <div className="rounded-md border bg-card/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          {t('chat:metrics.timeline.title', { count: turns.length })}
        </div>
        <button
          type="button"
          onClick={() => setAllOpen((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {allOpen ? t('chat:metrics.timeline.collapseAll') : t('chat:metrics.timeline.expandAll')}
        </button>
      </div>
      <div className="space-y-1">
        {turns.map((row) => (
          <TurnRowView key={row.id} row={row} maxInput={maxInput} forceOpen={allOpen} t={t} />
        ))}
      </div>
    </div>
  );
}

function TurnRowView({
  row,
  maxInput,
  forceOpen,
  t,
}: {
  row: TurnRow;
  maxInput: number;
  forceOpen: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = forceOpen || open;
  const input = row.input_tokens ?? 0;
  const cacheRead = row.cache_read_input_tokens ?? 0;
  const cacheCreate = row.cache_creation_input_tokens ?? 0;
  const output = row.output_tokens ?? 0;
  const thinking = row.thinking_tokens ?? 0;
  const fresh = Math.max(0, input - cacheRead);
  const inputPct = maxInput > 0 ? (input / maxInput) * 100 : 0;
  const cachePct = input > 0 ? Math.round((cacheRead / input) * 100) : 0;

  let toolNames: string[] = [];
  if (row.tools_called_json) {
    try {
      const arr = JSON.parse(row.tools_called_json);
      if (Array.isArray(arr)) toolNames = arr.filter((n) => typeof n === 'string');
    } catch {
      /* ignore */
    }
  }

  // Stacked bar segments (cache-read vs fresh-input vs output).
  const segTotal = Math.max(1, input + output);
  const cacheReadSeg = (cacheRead / segTotal) * 100;
  const freshSeg = (fresh / segTotal) * 100;
  const outputSeg = (output / segTotal) * 100;

  return (
    <div className="border rounded-md bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2 py-1.5 flex items-center gap-2 text-xs hover:bg-muted/30 transition-colors text-left"
      >
        {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="font-mono text-[11px] w-10 shrink-0">
          T{row.turn}
          {row.is_subagent ? '·sub' : ''}
        </span>
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden flex">
          <div
            className="bg-primary"
            style={{ width: `${inputPct}%` }}
            title={`input ${input} tok`}
          />
        </div>
        <span className="tabular-nums text-muted-foreground shrink-0">
          {formatK(input)} in · {formatK(output)} out
        </span>
        <span
          className={`tabular-nums shrink-0 ${
            cachePct >= 60 ? 'text-emerald-600 dark:text-emerald-400' : cachePct < 30 && row.turn > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
          }`}
        >
          {cachePct}% cache
        </span>
        <span className="tabular-nums text-muted-foreground shrink-0 w-12 text-right">
          {row.tool_count > 0 ? `${row.tool_count} tool${row.tool_count > 1 ? 's' : ''}` : '—'}
        </span>
      </button>

      {isOpen && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t">
          {/* Stacked breakdown bar */}
          <div>
            <div className="flex h-2 rounded-full overflow-hidden bg-muted">
              <div className="bg-emerald-500" style={{ width: `${cacheReadSeg}%` }} title={`cached ${cacheRead}`} />
              <div className="bg-primary" style={{ width: `${freshSeg}%` }} title={`fresh input ${fresh}`} />
              <div className="bg-amber-500" style={{ width: `${outputSeg}%` }} title={`output ${output}`} />
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px] mt-1">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t('chat:metrics.timeline.cached')}: {formatK(cacheRead)}
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t('chat:metrics.timeline.fresh')}: {formatK(fresh)}
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                {t('chat:metrics.timeline.output')}: {formatK(output)}
              </span>
            </div>
          </div>

          {/* Detail grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <DetailItem label={t('chat:metrics.timeline.cacheRead')} value={formatK(cacheRead)} />
            <DetailItem label={t('chat:metrics.timeline.cacheCreate')} value={formatK(cacheCreate)} />
            <DetailItem label={t('chat:metrics.timeline.thinking')} value={formatK(thinking)} />
            <DetailItem label={t('chat:metrics.timeline.history')} value={formatK(row.history_chars ?? 0) + ' ch'} />
            {row.largest_tool_result_chars !== null && (
              <DetailItem
                label={t('chat:metrics.timeline.largestResult')}
                value={`${formatK(row.largest_tool_result_chars)} ch`}
              />
            )}
            {row.compaction_triggered === 1 && (
              <DetailItem label={t('chat:metrics.timeline.compaction')} value="✓" intent="warn" />
            )}
            {row.summarizer_ran === 1 && (
              <DetailItem label={t('chat:metrics.timeline.summarizer')} value="✓" intent="warn" />
            )}
            {row.paginate_count > 0 && (
              <DetailItem label={t('chat:metrics.timeline.paginate')} value={String(row.paginate_count)} intent="warn" />
            )}
          </div>

          {/* Tools called list */}
          {toolNames.length > 0 && (
            <div className="pt-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                {t('chat:metrics.timeline.toolsCalled')}
              </div>
              <div className="flex flex-wrap gap-1">
                {toolNames.map((name, i) => (
                  <span
                    key={`${row.id}-${i}-${name}`}
                    className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="text-[10px] text-muted-foreground">
            {row.provider ?? '—'}
            {row.model ? ` / ${row.model}` : ''}
            {' · '}
            {row.created_at ? new Date(row.created_at).toLocaleTimeString() : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailItem({ label, value, intent }: { label: string; value: string; intent?: 'warn' }) {
  const valueClass = intent === 'warn' ? 'text-amber-600 dark:text-amber-400' : '';
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

function ToolBar({ name, calls, max }: { name: string; calls: number; max: number }) {
  const pct = max > 0 ? Math.round((calls / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-44 truncate font-mono text-[11px]" title={name}>{name}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right tabular-nums text-muted-foreground">{calls}</span>
    </div>
  );
}
