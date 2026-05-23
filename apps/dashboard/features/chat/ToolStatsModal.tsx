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
import { AlertCircle, BarChart3, RefreshCw, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { ScrollArea } from '../../components/ui/scroll-area.js';
import { Badge } from '../../components/ui/badge.js';

interface ToolStatsResponse {
  sessionId: number;
  totalCalls: number;
  byName: Array<{
    name: string;
    count: number;
    errorCount: number;
    lastAt: string | null;
  }>;
  recent: Array<{
    id: number;
    name: string;
    argsPreview: string;
    isError: boolean;
    durationMs: number;
    createdAt: string;
  }>;
}

interface ToolStatsModalProps {
  sessionId: number;
  open: boolean;
  onClose: () => void;
}

export function ToolStatsModal({ sessionId, open, onClose }: ToolStatsModalProps) {
  const [data, setData] = useState<ToolStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!open) return;
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
  }, [open, sessionId, refreshTick]);

  if (!open) return null;

  const dominant = data && data.byName.length > 0 ? data.byName[0] : null;
  const dominantPct = dominant && data && data.totalCalls > 0
    ? Math.round((dominant.count / data.totalCalls) * 100)
    : 0;
  const maxCount = data ? Math.max(1, ...data.byName.map((b) => b.count)) : 1;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border rounded-lg shadow-lg w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold flex-1">Tool stats — session {sessionId}</h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRefreshTick((n) => n + 1)}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} title="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-4">
            {loading && !data && (
              <div className="text-xs text-muted-foreground">Loading tool stats…</div>
            )}

            {data && (
              <>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Total tool calls:</span>
                  <span className="font-mono font-semibold tabular-nums">{data.totalCalls}</span>
                  {dominant && (
                    <>
                      <span className="text-muted-foreground sm:ml-auto">Dominant:</span>
                      <span className="font-mono font-semibold">
                        {dominant.name}{' '}
                        <span className="text-muted-foreground">({dominantPct}%)</span>
                      </span>
                    </>
                  )}
                </div>

                {data.byName.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-8">
                    No tool calls recorded for this session.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      By tool
                    </div>
                    {data.byName.map((b) => {
                      const pct = data.totalCalls > 0
                        ? Math.round((b.count / data.totalCalls) * 100)
                        : 0;
                      const widthPct = Math.round((b.count / maxCount) * 100);
                      const flagged = pct >= 20 || b.errorCount > 0;
                      return (
                        <div key={b.name} className="text-xs">
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono truncate flex-1">{b.name}</span>
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
                                {b.errorCount} err
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
                      Recent calls (newest first)
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
                          <div className="flex items-baseline gap-2 min-w-0">
                            <span className="font-mono font-medium truncate">{r.name}</span>
                            {r.isError && (
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0 border-destructive/40 text-destructive shrink-0"
                              >
                                error
                              </Badge>
                            )}
                            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums shrink-0">
                              {r.durationMs}ms
                            </span>
                            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                              {r.createdAt}
                            </span>
                          </div>
                          <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                            {r.argsPreview || '(no args)'}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
