import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Activity, AlertTriangle, BarChart3, ChevronDown, ChevronRight, Database, DollarSign, FileText, History, Loader2, MessageSquare, PiggyBank, Scissors, Wrench } from 'lucide-react';
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
  /** Stable per-round identifier. All turns of one user message share the
   *  same `run_id`; we group the timeline by it so each round renders as
   *  one collapsible block. */
  run_id: string;
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
  /** Prompt-cache diagnostics (mig 143). NULL on rows older than the migration. */
  tools_fingerprint?: string | null;
  prefix_head_hash?: string | null;
  reducer_retired_count?: number | null;
  reducer_freed_chars?: number | null;
}

/** One "round" = all the assistant turns triggered by a single user
 *  message. Built client-side from a flat `TurnRow[]` ordered by insertion. */
interface TurnRound {
  runId: string;
  /** 1-based index, in order of appearance in the session. */
  index: number;
  turns: TurnRow[];
  totals: {
    input: number;
    output: number;
    cacheRead: number;
  };
  /** ISO of the earliest turn in the round — used as the round header timestamp. */
  startedAt: string | null;
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
  /** Migration 130 — lifetime durable-compaction counts (auto + manual). */
  compaction_count_auto: number;
  compaction_count_manual: number;
  /** Migration 130 — lifetime message counts (independent of the summary boundary). */
  messages_all: number;
  messages_conversation: number;
  messages_user: number;
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
  /** Fase 3 — "Economia Real" per-technique savings (optional for older API responses). */
  savings?: {
    cacheSavedUsd: number;
    cacheReadTokens: number;
    cacheHitRatio: number;
    shapingSavedChars: number;
    shapingSavedTokensEst: number;
    shapingSavedUsdEst: number;
    tierSavedTokensEstPerTurn: number;
    tierSavedTokensEstTotal: number;
    hasUnpricedTurns: boolean;
  };
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

/**
 * Headless body of the session-metrics surface. Reused by the legacy
 * modal AND the right-rail `SessionMetricsPanel`.
 */
export function SessionMetricsView({
  sessionId,
  active,
}: {
  sessionId: number | null;
  active: boolean;
}) {
  const { t } = useTranslation(['chat', 'common']);
  const url = active && sessionId ? `/sessions/${sessionId}/telemetry` : '';
  const { data, loading, error } = useApi<SessionTelemetrySummary>(url);
  return (
    <div className="flex-1 overflow-auto space-y-4 pr-1 px-3 py-2">
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
              {/* Session size — message counts (lifetime, independent of the
                  summary boundary) + how many times the window was summarized
                  (durable auto + manual). Migration 130. */}
              <Section title={t('chat:metrics.session.title')} icon={<MessageSquare className="h-3.5 w-3.5" />}>
                <Stat label={t('chat:metrics.session.msgsConversation')} value={String(data.messages_conversation)} />
                <Stat label={t('chat:metrics.session.msgsAll')} value={String(data.messages_all)} />
                <Stat label={t('chat:metrics.session.msgsUser')} value={String(data.messages_user)} />
                <Stat
                  label={t('chat:metrics.session.summarizations')}
                  value={String(data.compaction_count_auto + data.compaction_count_manual)}
                />
                <Stat label={t('chat:metrics.session.summAuto')} value={String(data.compaction_count_auto)} />
                <Stat label={t('chat:metrics.session.summManual')} value={String(data.compaction_count_manual)} />
              </Section>

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

              {/* Economia Real — per-technique savings. Cache is exact; shaping
                  counts forward only (older rows had NULL shaped); tiers is an estimate. */}
              {data.savings && (
                <Section title={t('chat:metrics.savings.title')} icon={<PiggyBank className="h-3.5 w-3.5" />}>
                  <Stat
                    label={t('chat:metrics.savings.cache')}
                    value={`${formatUsd(data.savings.cacheSavedUsd)}${data.savings.hasUnpricedTurns ? '+' : ''}`}
                    intent="good"
                  />
                  <Stat
                    label={t('chat:metrics.savings.shaping')}
                    value={data.savings.shapingSavedTokensEst > 0 ? `${formatK(data.savings.shapingSavedTokensEst)} tok` : '—'}
                  />
                  <Stat
                    label={t('chat:metrics.savings.tiers')}
                    value={`~${formatK(data.savings.tierSavedTokensEstPerTurn)} tok/turn`}
                  />
                </Section>
              )}

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
  );
}

export function SessionMetricsModal({ open, onOpenChange, sessionId }: SessionMetricsModalProps) {
  const { t } = useTranslation(['chat']);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            {t('chat:metrics.title')}
          </DialogTitle>
        </DialogHeader>
        <SessionMetricsView sessionId={sessionId} active={open} />
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

/**
 * Group a flat list of turn rows into rounds (one per `run_id`) in the
 * order they first appeared. Each user message starts a new run, so the
 * resulting list reads "Round 1: first message's turns…", "Round 2: …",
 * matching how the user perceives the conversation.
 *
 * Falls back gracefully if `run_id` is missing on legacy rows by treating
 * the row as its own one-off round (keyed by id).
 */
function groupTurnsByRound(turns: TurnRow[]): TurnRound[] {
  const byRun = new Map<string, TurnRound>();
  const order: string[] = [];
  for (const t of turns) {
    const key = t.run_id || `legacy-${t.id}`;
    let bucket = byRun.get(key);
    if (!bucket) {
      bucket = {
        runId: key,
        index: order.length + 1,
        turns: [],
        totals: { input: 0, output: 0, cacheRead: 0 },
        startedAt: t.created_at ?? null,
      };
      byRun.set(key, bucket);
      order.push(key);
    }
    bucket.turns.push(t);
    bucket.totals.input += t.input_tokens ?? 0;
    bucket.totals.output += t.output_tokens ?? 0;
    bucket.totals.cacheRead += t.cache_read_input_tokens ?? 0;
  }
  return order.map((k) => byRun.get(k)!);
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
  // Compute max input across ALL turns (not per-round) so the bar scale
  // stays consistent across rounds — easier to eyeball which round was
  // the heavy one.
  const maxInput = turns.reduce((m, r) => Math.max(m, r.input_tokens ?? 0), 0);
  const rounds = groupTurnsByRound(turns);
  // Previous turn in GLOBAL session order (per main/subagent class) — a
  // round's T1 compares against the LAST turn of the previous round, which
  // is exactly where a toolset flip shows up. Used by the cache-bust badge.
  const prevById = new Map<number, TurnRow | null>();
  {
    let prevMain: TurnRow | null = null;
    let prevSub: TurnRow | null = null;
    for (const row of turns) {
      if (row.is_subagent) {
        prevById.set(row.id, prevSub);
        prevSub = row;
      } else {
        prevById.set(row.id, prevMain);
        prevMain = row;
      }
    }
  }

  // Pluralisation suffixes for the header. i18n's count interpolation is
  // ICU-style and we're using plain {{var}}; cheap workaround is to pass
  // the "s" as a separate var.
  const roundsPlural = rounds.length === 1 ? '' : 's';
  const turnsPlural = turns.length === 1 ? '' : 's';

  return (
    <div className="rounded-md border bg-card/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          {t('chat:metrics.timeline.title', {
            rounds: rounds.length,
            roundsPlural,
            count: turns.length,
            turnsPlural,
          })}
        </div>
        <button
          type="button"
          onClick={() => setAllOpen((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {allOpen ? t('chat:metrics.timeline.collapseAll') : t('chat:metrics.timeline.expandAll')}
        </button>
      </div>
      <div className="space-y-2">
        {rounds.map((round) => (
          <RoundGroup
            key={round.runId}
            round={round}
            maxInput={maxInput}
            forceOpen={allOpen}
            // Newest round (last in array) is most relevant; default it
            // open. Older rounds collapsed by default to keep the modal
            // scrollable when sessions get long.
            defaultOpen={round.index === rounds.length}
            prevById={prevById}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One collapsible block per round. Header shows the round number, turn
 * count, and aggregated in/out/cache so the user can scan rounds without
 * expanding. Cache % uses cache_read / input across the whole round —
 * matches the per-turn semantics so the numbers compose naturally.
 */
function RoundGroup({
  round,
  maxInput,
  forceOpen,
  defaultOpen,
  prevById,
  t,
}: {
  round: TurnRound;
  maxInput: number;
  forceOpen: boolean;
  defaultOpen: boolean;
  prevById: Map<number, TurnRow | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;
  const { input, output, cacheRead } = round.totals;
  const cachePct = input > 0 ? Math.round((cacheRead / input) * 100) : 0;
  const turnsLabel =
    round.turns.length === 1
      ? t('chat:metrics.timeline.roundTurnsOne')
      : t('chat:metrics.timeline.roundTurnsMany', { count: round.turns.length });

  return (
    <div className="rounded-md border bg-background/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 text-xs hover:bg-muted/30 transition-colors text-left"
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="font-semibold text-[11px] shrink-0">
          {t('chat:metrics.timeline.round', { n: round.index })}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          · {turnsLabel}
        </span>
        <span className="flex-1" />
        <span className="tabular-nums text-muted-foreground shrink-0 text-[11px]">
          {formatK(input)} in · {formatK(output)} out
        </span>
        <span
          className={`tabular-nums shrink-0 text-[11px] w-16 text-right ${
            cachePct >= 60
              ? 'text-emerald-600 dark:text-emerald-400'
              : cachePct < 30 && round.turns.length > 1
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
          }`}
        >
          {cachePct}% cache
        </span>
      </button>
      {isOpen && (
        <div className="px-2 pb-2 pt-1 space-y-1 border-t bg-card/20">
          {round.turns.map((row) => (
            <TurnRowView
              key={row.id}
              row={row}
              prev={prevById.get(row.id) ?? null}
              maxInput={maxInput}
              forceOpen={forceOpen}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TurnRowView({
  row,
  prev,
  maxInput,
  forceOpen,
  t,
}: {
  row: TurnRow;
  /** Previous turn in global session order (same main/subagent class). */
  prev: TurnRow | null;
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

  // Cache-bust cause badge (mig 143): when the cache hit drops sharply vs
  // the previous turn, the fingerprints say WHICH prefix segment diverged.
  // Rows from before the migration have NULL hashes → no badge.
  const bustCause = (() => {
    if (!prev?.input_tokens) return null;
    const prevPct = Math.round(((prev.cache_read_input_tokens ?? 0) / prev.input_tokens) * 100);
    if (prevPct < 50 || prevPct - cachePct < 40) return null;
    if (!row.tools_fingerprint || !prev.tools_fingerprint || !row.prefix_head_hash || !prev.prefix_head_hash) return null;
    if (row.tools_fingerprint !== prev.tools_fingerprint) return 'toolset';
    if (row.prefix_head_hash !== prev.prefix_head_hash) {
      const reducerMoved =
        (row.reducer_retired_count ?? 0) !== (prev.reducer_retired_count ?? 0) ||
        (row.reducer_freed_chars ?? 0) !== (prev.reducer_freed_chars ?? 0);
      return reducerMoved ? 'historyReducer' : 'history';
    }
    return 'ttl';
  })();

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
        {bustCause && (
          <span
            className={`shrink-0 rounded px-1 py-px text-[9px] uppercase tracking-wide ${
              bustCause === 'toolset'
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : bustCause === 'ttl'
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
            }`}
            title={t(`chat:metrics.timeline.bust.${bustCause}Hint`)}
          >
            {t(`chat:metrics.timeline.bust.${bustCause}`)}
          </span>
        )}
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
