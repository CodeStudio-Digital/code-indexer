/**
 * Diagnostic modal: aggregated tool-call breakdown for the active
 * coder session. Hits `GET /api/coder/sessions/:id/tool-stats` once
 * on open and renders:
 *
 *   - Total tool calls + dominant tool (% share)
 *   - Bar chart of each tool name with count + error count
 *   - Chronological tail of the last 30 calls (args preview + error
 *     flag + duration)
 *
 * Use case: user notices a session burning tokens and not making
 * obvious progress. Opens "Tool Stats" → in two seconds sees
 * "update_todo: 67 (31%)" and confirms the suspicion. Without this,
 * the only way to diagnose was a manual SQL query against the DB.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, RefreshCw, Scissors } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';

interface SavingsByTool {
  name: string;
  rawChars: number;
  shapedChars: number;
  savedChars: number;
}

interface ToolStatsResponse {
  sessionId: string;
  totalCalls: number;
  directCalls?: number;
  nestedCalls?: number;
  guardOutcomes?: {
    genuineErrors: number;
    rootRefusals: number;
    propagatedParentFailures: number;
    reusedCalls: number;
    shadowCandidates: number;
  };
  byName: Array<{
    name: string;
    count: number;
    errorCount: number;
    refusedCount?: number;
    propagatedFailureCount?: number;
    reuseCount?: number;
    shadowCount?: number;
    lastAt: string | null;
  }>;
  recent: Array<{
    id: string;
    seq: number;
    name: string;
    argsPreview: string;
    isError: boolean;
    durationMs: number;
    createdAt: string;
    outcome?: 'success' | 'genuine_error' | 'root_refusal' | 'propagated_parent_failure' | 'reuse' | 'shadow';
    guardAction?: string | null;
    guardReason?: string | null;
  }>;
  /**
   * Optional for forward-compat: pre-migration-102 servers don't return
   * this field. Component shows the savings card only when present and
   * `totalSavedChars > 0`.
   */
  savings?: {
    totalRawChars: number;
    totalShapedChars: number;
    totalSavedChars: number;
    totalSavedTokensEst: number;
    byTool: SavingsByTool[];
    semanticSavedChars?: number;
    jsonCrushSavedChars?: number;
    hardCapSavedChars?: number;
    nestedRawChars?: number;
  };
}

function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Headless body of the tool-stats surface. Owns its own fetch lifecycle
 * (refreshable via the refresh button rendered inline). Reused by the
 * legacy modal AND the right-rail `ToolStatsPanel`.
 */
export function ToolStatsView({
  sessionId,
  active,
}: {
  sessionId: string;
  /** When false, the view skips fetching. Used by the rail to suspend
   *  the panel when it's not the active one. */
  active: boolean;
}) {
  const { t } = useTranslation('chat');
  const [data, setData] = useState<ToolStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/coder/sessions/${sessionId}/tool-stats?recent=50`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ToolStatsResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, refreshTick]);

  const dominant = data && data.byName.length > 0 ? data.byName[0] : null;
  const dominantPct = dominant && data && data.totalCalls > 0
    ? Math.round((dominant.count / data.totalCalls) * 100)
    : 0;
  const maxCount = data ? Math.max(1, ...data.byName.map((b) => b.count)) : 1;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0">
        <span className="text-[11px] text-muted-foreground">{t('toolStats.session', { id: sessionId })}</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 w-6 p-0"
          onClick={() => setRefreshTick((n) => n + 1)}
          disabled={loading}
          title={t('toolStats.refresh')}
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive shrink-0">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-3 space-y-4">
            {loading && !data && (
              <div className="text-xs text-muted-foreground">{t('toolStats.loading')}</div>
            )}

            {data && (
              <>
                <div
                  className="grid gap-x-4 gap-y-2 text-xs"
                  style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))' }}
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-muted-foreground">{t('toolStats.totalCalls')}</span>
                      <span className="font-mono font-semibold tabular-nums">{data.totalCalls}</span>
                    </div>
                    {data.directCalls != null && data.nestedCalls != null && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {t('toolStats.scopeCalls', { direct: data.directCalls, nested: data.nestedCalls })}
                      </div>
                    )}
                  </div>
                  {dominant && (
                    <div className="min-w-0">
                      <div className="text-[10px] text-muted-foreground">{t('toolStats.dominant')}</div>
                      <div className="truncate font-mono font-semibold" title={dominant.name}>
                        {dominant.name}{' '}
                        <span className="text-muted-foreground">({dominantPct}%)</span>
                      </div>
                    </div>
                  )}
                </div>

                {data.guardOutcomes && (
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t('toolStats.guardOutcomes')}
                    </div>
                    <div
                      className="grid gap-2 text-[10px]"
                      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))' }}
                    >
                      {([
                        ['genuineErrors', 'toolStats.genuineErrors', 'text-destructive'],
                        ['rootRefusals', 'toolStats.rootRefusals', 'text-amber-600 dark:text-amber-400'],
                        ['propagatedParentFailures', 'toolStats.propagatedFailures', 'text-orange-600 dark:text-orange-400'],
                        ['reusedCalls', 'toolStats.reusedCalls', 'text-emerald-600 dark:text-emerald-400'],
                        ['shadowCandidates', 'toolStats.shadowCandidates', 'text-sky-600 dark:text-sky-400'],
                      ] as const).map(([key, label, color]) => (
                        <div key={key} className="min-w-0 rounded border bg-background/60 px-2 py-1.5">
                          <div className={`font-mono text-sm font-semibold tabular-nums ${color}`}>
                            {data.guardOutcomes?.[key] ?? 0}
                          </div>
                          <div className="break-words leading-tight text-muted-foreground">{t(label)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Smart reducer savings — only renders when the server
                    returned a `savings` block AND there was something to
                    save. Pre-migration-102 servers or sessions with zero
                    savings yield an absent or empty card; the dashboard
                    falls back to the existing by-tool/recent view. */}
                {data.savings && data.savings.totalSavedChars > 0 && (() => {
                  const sv = data.savings;
                  const savedPct = sv.totalRawChars > 0
                    ? Math.round((sv.totalSavedChars / sv.totalRawChars) * 100)
                    : 0;
                  const maxToolSaved = Math.max(1, ...sv.byTool.map((t) => t.savedChars));
                  return (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
                      <div className="flex items-baseline gap-2 text-xs">
                        <Scissors className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                          {t('toolStats.savings')}
                        </span>
                        <span className="ml-auto font-mono tabular-nums text-emerald-700 dark:text-emerald-300">
                          {t('toolStats.chars', { count: formatChars(sv.totalSavedChars) })}
                        </span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {t('toolStats.tokens', { count: formatChars(sv.totalSavedTokensEst) })}
                        </span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {t('toolStats.rawPercent', { count: savedPct })}
                        </span>
                      </div>
                      <div
                        className="grid gap-1 text-[10px] text-muted-foreground"
                        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))' }}
                      >
                        <span>{t('toolStats.semantic')}: <b className="font-mono">{formatChars(sv.semanticSavedChars ?? 0)}</b></span>
                        <span>{t('toolStats.jsonCrush')}: <b className="font-mono">{formatChars(sv.jsonCrushSavedChars ?? 0)}</b></span>
                        <span>{t('toolStats.hardCap')}: <b className="font-mono">{formatChars(sv.hardCapSavedChars ?? 0)}</b></span>
                        <span title={t('toolStats.nestedHint')}>{t('toolStats.nestedVolume')}: <b className="font-mono">{formatChars(sv.nestedRawChars ?? 0)}</b></span>
                      </div>
                      {sv.byTool.length > 0 && (
                        <div className="space-y-1">
                          {sv.byTool.slice(0, 5).map((t) => {
                            const widthPct = Math.round((t.savedChars / maxToolSaved) * 100);
                            const toolPct = t.rawChars > 0
                              ? Math.round((t.savedChars / t.rawChars) * 100)
                              : 0;
                            return (
                              <div key={t.name} className="text-[11px]">
                                <div className="flex items-baseline gap-2">
                                  <span className="font-mono truncate flex-1">{t.name}</span>
                                  <span className="font-mono tabular-nums text-muted-foreground">
                                    {formatChars(t.savedChars)}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground w-10 text-right">
                                    {toolPct}%
                                  </span>
                                </div>
                                <div className="h-1 mt-0.5 rounded-full bg-muted overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-emerald-500/70 transition-all"
                                    style={{ width: `${widthPct}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {data.byName.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-8">
                    {t('toolStats.empty')}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t('toolStats.byTool')}
                    </div>
                    {data.byName.map((b) => {
                      const pct = data.totalCalls > 0
                        ? Math.round((b.count / data.totalCalls) * 100)
                        : 0;
                      const widthPct = Math.round((b.count / maxCount) * 100);
                      const flagged = pct >= 20 || b.errorCount > 0
                        || (b.refusedCount ?? 0) > 0
                        || (b.propagatedFailureCount ?? 0) > 0;
                      return (
                        <div key={b.name} className="text-xs">
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span className="min-w-[110px] flex-1 truncate font-mono" title={b.name}>{b.name}</span>
                            <span className="font-mono tabular-nums text-muted-foreground">
                              {b.count}
                            </span>
                            <span className="text-[10px] text-muted-foreground w-10 text-right">
                              {pct}%
                            </span>
                            {b.errorCount > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 border-destructive/40 text-destructive"
                              >
                                {t('toolStats.errShort', { count: b.errorCount })}
                              </Badge>
                            )}
                            {(b.refusedCount ?? 0) > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 border-amber-500/40 text-amber-600 dark:text-amber-400"
                              >
                                {t('toolStats.refusedShort', { count: b.refusedCount })}
                              </Badge>
                            )}
                            {(b.propagatedFailureCount ?? 0) > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 border-orange-500/40 text-orange-600 dark:text-orange-400"
                              >
                                {t('toolStats.propagatedShort', { count: b.propagatedFailureCount })}
                              </Badge>
                            )}
                          </div>
                          <div className="h-1.5 mt-0.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                flagged ? 'bg-amber-500' : 'bg-primary/70'
                              }`}
                              style={{ width: `${widthPct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {data.recent.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t('toolStats.recent')}
                    </div>
                    <div className="space-y-0.5">
                      {data.recent.map((r) => (
                        <div
                          key={r.id}
                          className={`text-[11px] rounded px-2 py-1 border min-w-0 ${
                            r.isError
                              ? 'border-destructive/30 bg-destructive/5'
                              : 'border-border/40 bg-muted/30'
                          }`}
                        >
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span className="min-w-[100px] flex-1 truncate font-mono font-medium" title={r.name}>{r.name}</span>
                            {r.outcome && r.outcome !== 'success' ? (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 border-amber-500/40 text-amber-600 dark:text-amber-400 shrink-0"
                                title={r.guardReason ?? undefined}
                              >
                                {t(`toolStats.outcome.${r.outcome}`)}
                              </Badge>
                            ) : r.isError && (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 border-destructive/40 text-destructive shrink-0"
                              >
                                {t('toolStats.error')}
                              </Badge>
                            )}
                            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                              {r.durationMs}ms
                            </span>
                            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                              {r.createdAt}
                            </span>
                          </div>
                          <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                            {r.argsPreview || t('toolStats.noArgs')}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
        </div>
      </div>
    </div>
  );
}
