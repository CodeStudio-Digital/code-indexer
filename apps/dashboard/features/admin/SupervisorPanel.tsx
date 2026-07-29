/**
 * SupervisorPanel — operational dashboard for the AgentSupervisor
 * (Sprint 4 Phase 3.3).
 *
 * Displays:
 *   - One card per active company-session worker showing its status
 *     (running, tracked agents by state, stuck count, breaker state)
 *   - Live incidents log (replay + SSE stream from
 *     `/api/admin/supervisor/stream`)
 *   - Per-session operator actions:
 *       • Release role quarantine (when any role in the session is
 *         currently quarantined by the per-role breaker)
 *       • Release read-only mode (when the global breaker tripped)
 *
 * The status snapshot polls every 5s (status is in-memory per worker
 * — not persisted, so polling is the right primitive). Incidents flow
 * via SSE for near-real-time updates.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePolling } from '../../hooks/usePolling.js';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  RadioTower,
  RefreshCcw,
  ShieldCheck,
  ShieldOff,
  Unlock,
} from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { ScrollArea } from '../../components/ui/scroll-area.js';
import {
  fetchSupervisorIncidents,
  fetchSupervisorStatus,
  openSupervisorStream,
  releaseReadOnlyMode,
  releaseRoleQuarantine,
  type IncidentRow,
  type StatusResponse,
  type SupervisorIncidentEnvelope,
} from './supervisor-api.js';

const POLL_MS = 5_000;

function formatMsAgo(ms: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return t('supervisor.time.secondsAgo', { count: s });
  if (s < 3600) return t('supervisor.time.minutesAgo', { count: Math.floor(s / 60) });
  return t('supervisor.time.hoursAgo', { count: Math.floor(s / 3600) });
}

function severityColor(kind: string): 'red' | 'orange' | 'yellow' | 'gray' {
  if (kind === 'agent_quarantined' || kind === 'role_quarantined' || kind === 'read_only_mode') {
    return 'red';
  }
  if (kind === 'stuck_detected' || kind === 'loop_enforced') return 'orange';
  if (kind === 'illegal_transition' || kind === 'observation_error') return 'yellow';
  return 'gray';
}

export interface SupervisorPanelProps {
  /**
   * When provided, filter the status snapshot + incidents query to
   * just this session. Used by the right-rail entry in
   * `CompanySessionView` so the operator sees the supervisor data
   * scoped to whatever session they're already viewing. Omitting
   * shows ALL active sessions (used by the global `/telemetry` tab).
   */
  sessionId?: string;
  /**
   * Chrome to render around the panel body:
   *   - 'rail'      : full-height, compact — for the CompanySessionView
   *                   right rail (the historical default).
   *   - 'dashboard' : flows in a scrolling page with a subtitle and
   *                   naturally-sized cards, matching the sibling
   *                   `/telemetry` tabs (Overview / Prices / Completion).
   */
  variant?: 'rail' | 'dashboard';
}

type StreamState = 'connecting' | 'live' | 'reconnecting';

export function SupervisorPanel({ sessionId, variant = 'rail' }: SupervisorPanelProps = {}): JSX.Element {
  const { t } = useTranslation('admin');
  const dashboard = variant === 'dashboard';
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [liveBuffer, setLiveBuffer] = useState<SupervisorIncidentEnvelope[]>([]);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const closeStreamRef = useRef<(() => void) | null>(null);
  // Mirror streamState into a ref so loadStatus can read it without listing it
  // as a dep (which would restart the poll on every connect/reconnect).
  const streamStateRef = useRef<StreamState>('connecting');
  useEffect(() => {
    streamStateRef.current = streamState;
  }, [streamState]);
  // One-shot per-session backfill of persisted incidents from the DB. NOT
  // gated on streamStateRef: the SSE stream's `connected` callback fires as
  // soon as the fetch headers land (a local round-trip), while
  // fetchSupervisorStatus() crosses a worker-thread RPC bridge — measurably
  // slower. That meant streamStateRef was almost always already 'live' by
  // the time loadStatus() checked it, so the DB backfill never ran and
  // historical incidents older than the SSE replay window (60s) never
  // appeared. Reset when the bound session changes; manual refresh clears
  // it to force a fresh pull.
  const incidentsBackfilledRef = useRef(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchSupervisorStatus();
      // Filter the global response to just the bound session when prop is set.
      const filtered: StatusResponse =
        sessionId != null
          ? { ...s, sessions: s.sessions.filter((row) => row.sessionId === sessionId) }
          : s;
      setStatus(filtered);
      // Side-load incidents once per session-bind (see incidentsBackfilledRef
      // above). Prefer the bound session; otherwise fall back to the first
      // active session (global view).
      const targetSession = sessionId ?? s.sessions[0]?.sessionId;
      if (targetSession != null && !incidentsBackfilledRef.current) {
        try {
          const inc = await fetchSupervisorIncidents(targetSession, 30);
          setIncidents(inc.incidents);
          incidentsBackfilledRef.current = true;
        } catch {
          /* incidents fetch is best-effort */
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Immediate load on mount + whenever the bound session changes. Reset the
  // backfill so switching the bound session re-seeds its incident history.
  useEffect(() => {
    incidentsBackfilledRef.current = false;
    void loadStatus();
  }, [loadStatus]);
  // Recurring poll (status is in-memory per worker, not pushed by the SSE
  // stream). Visibility-aware: pauses while the window is hidden.
  usePolling(() => void loadStatus(), POLL_MS, { immediate: false });

  // Live incidents — uses `openSupervisorStream` (fetch+ReadableStream
  // SSE parser) so it works in both browser dev AND Electron's `mcp://`
  // custom protocol. Native EventSource only does http/https.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1_000;
    setStreamState('connecting');

    function connect(): void {
      if (cancelled) return;
      closeStreamRef.current = openSupervisorStream(
        {
          onConnected: () => {
            if (cancelled) return;
            backoffMs = 1_000;
            setStreamState('live');
          },
          onIncident: (env) => {
            if (cancelled) return;
            if (sessionId != null && env.sessionId !== sessionId) return;
            setLiveBuffer((prev) => [env, ...prev].slice(0, 50));
          },
          onError: () => {
            if (cancelled) return;
            setStreamState('reconnecting');
            closeStreamRef.current = null;
            const wait = Math.min(backoffMs, 30_000);
            backoffMs = Math.min(backoffMs * 2, 30_000);
            retryTimer = setTimeout(connect, wait);
          },
        },
        { since: Date.now() - 60_000 },
      );
    }

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      closeStreamRef.current?.();
      closeStreamRef.current = null;
    };
  }, [sessionId]);

  // Manual refresh — force a fresh DB pull even if the one-shot backfill
  // already ran. This is an explicit operator action, not the background
  // poll, so it should never silently no-op just because the SSE stream is
  // live.
  function handleRefresh(): void {
    incidentsBackfilledRef.current = false;
    void loadStatus();
  }

  async function handleReleaseQuarantine(sessionId: string, role: string): Promise<void> {
    setActionMsg(null);
    try {
      const r = await releaseRoleQuarantine(sessionId, role);
      setActionMsg(
        r.released
          ? t('supervisor.roleReleased', { role, sessionId })
          : t('supervisor.roleNotQuarantined', { role }),
      );
      void loadStatus();
    } catch (e) {
      setActionMsg(t('supervisor.releaseFailed', { message: (e as Error).message }));
    }
  }

  async function handleReleaseReadOnly(sessionId: string): Promise<void> {
    setActionMsg(null);
    try {
      const r = await releaseReadOnlyMode(sessionId);
      setActionMsg(
        r.released
          ? t('supervisor.readOnlyReleased', { sessionId })
          : t('supervisor.notReadOnly', { sessionId }),
      );
      void loadStatus();
    } catch (e) {
      setActionMsg(t('supervisor.releaseFailed', { message: (e as Error).message }));
    }
  }

  const hasSessions = (status?.sessions?.length ?? 0) > 0;
  const totalIncidents = liveBuffer.length + incidents.length;
  const allHealthy =
    hasSessions &&
    status!.sessions.every(
      (s) =>
        s.status != null &&
        s.status.stuckCount === 0 &&
        s.status.breakers.agents.every((a) => !a.tripped) &&
        s.status.breakers.roles.every((r) => r.quarantinedUntilMs == null) &&
        s.status.breakers.readOnlyUntilMs == null,
    );

  return (
    <div className={dashboard ? 'space-y-4' : 'flex flex-col h-full p-3 gap-3 min-h-0'}>
      {dashboard ? (
        // Dashboard tab: subtitle + a borderless controls row, matching the
        // sibling /telemetry tabs (Overview / Prices / Completion). The tab
        // label already names the section, so there's no standalone heading;
        // health is read from the body (session cards + incidents).
        <>
          <p className="text-sm text-muted-foreground">{t('supervisor.subtitle')}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={loading}
            >
              <RefreshCcw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
              {t('supervisor.refresh')}
            </Button>
            {status?.enabled === false && (
              <Badge variant="outline" className="text-[10px]">
                {t('supervisor.disabled')}
              </Badge>
            )}
          </div>
        </>
      ) : (
        // Rail: compact heading row with an at-a-glance health glyph.
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {allHealthy ? (
              <ShieldCheck className="h-5 w-5 text-emerald-500 flex-shrink-0" />
            ) : (
              <ShieldOff className="h-5 w-5 flex-shrink-0" />
            )}
            <h2 className="text-sm font-semibold truncate">{t('supervisor.title')}</h2>
            {status?.enabled === false && (
              <Badge variant="outline" className="ml-1 text-[10px]">
                {t('supervisor.disabled')}
              </Badge>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            title={t('supervisor.refresh')}
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className="text-xs text-muted-foreground bg-muted rounded px-2 py-1">{actionMsg}</div>
      )}

      {/* Sessions — flexible: empty state when nothing tracked */}
      {!hasSessions ? (
        <EmptySessionsHint dashboard={dashboard} />
      ) : (
        <div className={`space-y-2 ${dashboard ? '' : 'flex-shrink-0'}`}>
          {status!.sessions.map((s) => (
            <SessionStatusCard
              key={s.sessionId}
              sessionId={s.sessionId}
              status={s.status}
            onReleaseQuarantine={handleReleaseQuarantine}
            onReleaseReadOnly={handleReleaseReadOnly}
          />
          ))}
        </div>
      )}

      {/* Incidents — rail: flex-1 fills remaining height; dashboard: a
          naturally-sized card whose list scrolls within a capped height. */}
      <Card className={dashboard ? '' : 'flex-1 flex flex-col min-h-0'}>
        <CardHeader className={`py-2 px-3 ${dashboard ? '' : 'flex-shrink-0'}`}>
          <CardTitle className="text-xs font-medium flex items-center gap-2 text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>{t('supervisor.incidents')}</span>
            <div className="ml-auto flex items-center gap-1">
              {totalIncidents > 0 && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1">
                  {totalIncidents}
                </Badge>
              )}
              <StreamStateBadge state={streamState} />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className={`p-0 ${dashboard ? '' : 'flex-1 min-h-0'}`}>
          {totalIncidents === 0 ? (
            <EmptyIncidentsHint dashboard={dashboard} />
          ) : (
            // Rail fills remaining height via the radix ScrollArea (its
            // viewport resolves `h-full` against the flex parent). The
            // dashboard tab has no definite height, so it uses a plain
            // capped-overflow box — the same pattern as other telemetry lists.
            <IncidentsScroller dashboard={dashboard}>
              <div className="px-3 pb-3 space-y-1">
                {liveBuffer.map((env, idx) => (
                  <IncidentRowView
                    key={`live-${env.sessionId}-${env.detectedAtMs}-${idx}`}
                    kind={env.kind}
                    sessionId={env.sessionId}
                    agentRunId={env.agentRunId}
                    detail={env.detail}
                    detectedAtMs={env.detectedAtMs}
                    live
                  />
                ))}
                {incidents.map((row) => (
                  <IncidentRowView
                    key={`db-${row.id}`}
                    kind={row.incidentKind}
                    sessionId={row.companySessionId ?? 'unknown'}
                    agentRunId={row.agentRunId}
                    detail={row.detail}
                    detectedAtMs={row.detectedAtMs}
                  />
                ))}
              </div>
            </IncidentsScroller>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptySessionsHint({ dashboard }: { dashboard?: boolean }): JSX.Element {
  const { t } = useTranslation('admin');
  return (
    <div
      className={`rounded-md border p-3 text-xs text-muted-foreground space-y-2 ${
        dashboard ? 'bg-card/50' : 'border-dashed bg-muted/30 flex-shrink-0'
      }`}
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        <span className="font-medium text-foreground">{t('supervisor.emptySessions.title')}</span>
      </div>
      <p>{t('supervisor.emptySessions.description')}</p>
    </div>
  );
}

function StreamStateBadge({ state }: { state: StreamState }): JSX.Element {
  const { t } = useTranslation('admin');
  if (state === 'live') {
    return (
      <Badge
        variant="outline"
        className="text-[10px] h-4 px-1 flex items-center gap-1 border-emerald-500/40 text-emerald-500"
        title={t('supervisor.stream.liveTitle')}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
        {t('supervisor.stream.live')}
      </Badge>
    );
  }
  if (state === 'connecting') {
    return (
      <Badge
        variant="outline"
        className="text-[10px] h-4 px-1 flex items-center gap-1 text-muted-foreground"
        title={t('supervisor.stream.openingTitle')}
      >
        <RadioTower className="h-2.5 w-2.5 animate-pulse" />
        {t('supervisor.stream.opening')}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] h-4 px-1 flex items-center gap-1 border-amber-500/40 text-amber-500"
      title={t('supervisor.stream.reconnectingTitle')}
    >
      <RadioTower className="h-2.5 w-2.5 animate-pulse" />
      {t('supervisor.stream.reconnecting')}
    </Badge>
  );
}

function IncidentsScroller({
  dashboard,
  children,
}: {
  dashboard: boolean;
  children: ReactNode;
}): JSX.Element {
  if (dashboard) {
    return <div className="max-h-[28rem] overflow-y-auto">{children}</div>;
  }
  return <ScrollArea className="h-full">{children}</ScrollArea>;
}

function EmptyIncidentsHint({ dashboard }: { dashboard?: boolean }): JSX.Element {
  const { t } = useTranslation('admin');
  return (
    <div
      className={`flex flex-col items-center justify-center text-center gap-2 ${
        dashboard ? 'py-10 px-4' : 'h-full p-4'
      }`}
    >
      <ShieldCheck className="h-8 w-8 text-emerald-500/70" />
      <p className="text-sm font-medium text-foreground">{t('supervisor.emptyIncidents.title')}</p>
      <p className={`text-xs text-muted-foreground ${dashboard ? 'max-w-md' : 'max-w-[24ch]'}`}>
        {t('supervisor.emptyIncidents.description')}
      </p>
    </div>
  );
}

interface SessionStatusCardProps {
  sessionId: string;
  status: import('./supervisor-api.js').SupervisorStatus | null;
  onReleaseQuarantine: (sessionId: string, role: string) => Promise<void>;
  onReleaseReadOnly: (sessionId: string) => Promise<void>;
}

function SessionStatusCard({
  sessionId,
  status,
  onReleaseQuarantine,
  onReleaseReadOnly,
}: SessionStatusCardProps): JSX.Element {
  const { t } = useTranslation('admin');
  const readOnlyActive = status?.breakers.readOnlyUntilMs != null;
  const quarantinedRoles =
    status?.breakers.roles.filter((r) => r.quarantinedUntilMs != null) ?? [];
  const sessionHealthy =
    status != null &&
    status.stuckCount === 0 &&
    !readOnlyActive &&
    quarantinedRoles.length === 0;

  return (
    <Card>
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-xs font-medium flex items-center gap-2">
          {sessionHealthy ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          )}
          <span>{t('supervisor.sessionTitle', { sessionId })}</span>
          <div className="ml-auto flex gap-1">
            {readOnlyActive && (
              <Badge variant="destructive" className="text-[10px] h-4 px-1">
                <Lock className="h-2.5 w-2.5 mr-1" /> {t('supervisor.readOnly')}
              </Badge>
            )}
            {(status?.stuckCount ?? 0) > 0 && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1">
                {t('supervisor.stuck', { count: status?.stuckCount ?? 0 })}
              </Badge>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-0 text-xs space-y-2">
        {!status ? (
          <p className="text-muted-foreground">{t('supervisor.noData')}</p>
        ) : (
          <>
            <div className="flex gap-1 flex-wrap text-[10px] text-muted-foreground">
              <span>{t('supervisor.tracked', { count: status.trackedCount })}</span>
              <span>·</span>
              <span>{t('supervisor.incidentCount', { count: status.totalIncidents })}</span>
              <span>·</span>
              <span>{t('supervisor.ticks', { count: status.tickCount })}</span>
            </div>
            {Object.keys(status.byState).length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {Object.entries(status.byState).map(([state, count]) => (
                  <Badge key={state} variant="outline" className="text-[10px] h-4 px-1">
                    {state.toLowerCase().replace(/_/g, ' ')}: {count}
                  </Badge>
                ))}
              </div>
            )}
            {quarantinedRoles.length > 0 && (
              <div className="space-y-1 pt-1 border-t">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  {t('supervisor.quarantinedRoles')}
                </p>
                {quarantinedRoles.map((r) => (
                  <div key={r.role} className="flex items-center gap-2">
                    <Badge variant="destructive" className="text-[10px] h-4 px-1">
                      {r.role}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {t('supervisor.untilTime', { time: new Date(r.quarantinedUntilMs ?? 0).toLocaleTimeString() })}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-5 px-1.5 text-[10px]"
                      onClick={() => void onReleaseQuarantine(sessionId, r.role)}
                    >
                      <Unlock className="h-2.5 w-2.5 mr-1" />
                      {t('supervisor.release')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {readOnlyActive && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] w-full"
                onClick={() => void onReleaseReadOnly(sessionId)}
              >
                <Unlock className="h-2.5 w-2.5 mr-1" />
                {t('supervisor.releaseReadOnly')}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface IncidentRowProps {
  kind: string;
  sessionId: string;
  agentRunId: string | null;
  detail: string;
  detectedAtMs: number;
  live?: boolean;
}

function IncidentRowView(props: IncidentRowProps): JSX.Element {
  const { t } = useTranslation('admin');
  const color = severityColor(props.kind);
  const colorClass =
    color === 'red'
      ? 'border-red-500'
      : color === 'orange'
        ? 'border-orange-500'
        : color === 'yellow'
          ? 'border-yellow-500'
          : 'border-muted';
  return (
    <div className={`border-l-2 ${colorClass} pl-2 py-1 text-[11px] space-y-0.5`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-mono text-foreground">{props.kind}</span>
        {props.live && (
          <Badge variant="outline" className="text-[9px] h-3.5 px-1 leading-none">
            {t('supervisor.stream.live')}
          </Badge>
        )}
        <span className="ml-auto text-muted-foreground">{formatMsAgo(props.detectedAtMs, t)}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{t('supervisor.sessionMeta', { sessionId: props.sessionId })}</span>
        {props.agentRunId != null && <span>{t('supervisor.agentMeta', { agentRunId: props.agentRunId })}</span>}
      </div>
      <p className="text-muted-foreground break-words">{props.detail}</p>
    </div>
  );
}
