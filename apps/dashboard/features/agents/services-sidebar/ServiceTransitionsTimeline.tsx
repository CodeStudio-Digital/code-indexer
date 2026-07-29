/**
 * ServiceTransitionsTimeline — day-grouped audit trail of one service's
 * status/health flips (company B6). Read-only REST view over
 * `GET /services/transitions?service_id=` (mig-188 table); keyset
 * pagination via before_seq. Actor badge tells WHO flipped the state
 * (supervisor / operator / master / agent), kind badge WHICH machine
 * (container status vs probe health).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface TransitionRow {
  id: string;
  seq: number;
  service_id: string;
  kind: string;
  from_state: string | null;
  to_state: string;
  reason: string | null;
  actor: string;
  at_ms: number;
}

export interface ServiceTransitionsTimelineProps {
  sessionId?: string;
  serviceId?: string;
}

const PAGE_SIZE = 50;

function actorClass(actor: string): string {
  switch (actor) {
    case 'supervisor':
      return 'bg-violet-500/15 text-violet-600';
    case 'operator':
      return 'bg-sky-500/15 text-sky-600';
    case 'master':
      return 'bg-primary/15 text-primary';
    default:
      return 'bg-slate-500/15 text-slate-500';
  }
}

function stateClass(state: string): string {
  if (state === 'healthy' || state === 'running' || state === 'ready') return 'text-emerald-500';
  if (state === 'down' || state === 'error' || state === 'restart_failed') return 'text-red-500';
  if (state === 'degraded' || state === 'restarted') return 'text-amber-500';
  return 'text-muted-foreground';
}

export function ServiceTransitionsTimeline({ sessionId, serviceId }: ServiceTransitionsTimelineProps) {
  const { t } = useTranslation('agents');
  const [rows, setRows] = useState<TransitionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const fetchPage = useCallback(
    async (beforeSeq?: number) => {
      if (sessionId == null || !serviceId) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          service_id: serviceId,
          limit: String(PAGE_SIZE),
        });
        if (beforeSeq != null) params.set('before_seq', String(beforeSeq));
        const r = await fetch(`/api/company/sessions/${sessionId}/services/transitions?${params}`);
        if (!r.ok) return;
        const body = (await r.json()) as { transitions?: TransitionRow[] };
        const page = body.transitions ?? [];
        if (page.length < PAGE_SIZE) setExhausted(true);
        setRows((prev) => (beforeSeq != null ? [...prev, ...page] : page)); // newest-first
      } catch {
        /* best-effort */
      } finally {
        setLoading(false);
      }
    },
    [sessionId, serviceId],
  );

  useEffect(() => {
    setRows([]);
    setExhausted(false);
    void fetchPage();
  }, [fetchPage]);

  // Group (already newest-first) by calendar day for the section headers.
  const groups: Array<{ day: string; items: TransitionRow[] }> = [];
  for (const row of rows) {
    const day = new Date(row.at_ms).toLocaleDateString();
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(row);
    else groups.push({ day, items: [row] });
  }
  const oldestSeq = rows.length > 0 ? rows[rows.length - 1].seq : undefined;

  return (
    <div className="mt-1 rounded border bg-background/50 px-1.5 py-1 text-[9px]">
      {groups.length === 0 && (
        <div className="py-1 text-muted-foreground">{t('services.timeline.empty')}</div>
      )}
      {groups.map((group) => (
        <div key={group.day} className="mb-1">
          <div className="mb-0.5 text-[8px] uppercase tracking-wide text-muted-foreground">
            {group.day}
          </div>
          {group.items.map((row) => (
            <div key={row.id} className="flex items-start gap-1 py-0.5 border-b border-border/40 last:border-b-0">
              <span className="text-muted-foreground shrink-0">
                {new Date(row.at_ms).toLocaleTimeString()}
              </span>
              <span className={`rounded px-1 text-[8px] uppercase tracking-wide shrink-0 ${actorClass(row.actor)}`}>
                {row.actor}
              </span>
              <span className="rounded px-1 text-[8px] uppercase tracking-wide bg-muted text-muted-foreground shrink-0">
                {row.kind}
              </span>
              <span className="min-w-0">
                {row.from_state && (
                  <>
                    <span className={stateClass(row.from_state)}>{row.from_state}</span>
                    <span className="text-muted-foreground"> → </span>
                  </>
                )}
                <span className={stateClass(row.to_state)}>{row.to_state}</span>
                {row.reason && (
                  <span className="text-muted-foreground truncate" title={row.reason}>
                    {' '}— {row.reason}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      ))}
      {!exhausted && oldestSeq !== undefined && (
        <button
          type="button"
          className="mt-0.5 w-full rounded border px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent"
          disabled={loading}
          onClick={() => void fetchPage(oldestSeq)}
        >
          {loading ? '…' : t('services.timeline.loadMore')}
        </button>
      )}
    </div>
  );
}
