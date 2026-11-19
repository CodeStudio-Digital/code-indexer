/**
 * RequestTimeline — the per-request history tab. Lists past sends (newest
 * first) with status, duration, and the URL/error, so a request's behaviour
 * over time is visible, not just its last_status. Backed by api_request_history
 * (migration 148); re-fetches whenever the active request or `refreshToken`
 * (a fresh send) changes.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listRequestHistory } from './api.js';
import type { ApiRequestHistory } from './types.js';
import { StatusBadge } from './StatusBadge.js';

interface Props {
  projectId: number;
  requestId: number | null;
  /** Bump (e.g. the last SendResponse) to force a re-fetch after a send. */
  refreshToken?: unknown;
}

/** SQLite `datetime('now')` is "YYYY-MM-DD HH:MM:SS" — show the time part. */
function timePart(ts: string): string {
  const sp = ts.indexOf(' ');
  return sp === -1 ? ts : ts.slice(sp + 1);
}

export function RequestTimeline({ projectId, requestId, refreshToken }: Props) {
  const { t } = useTranslation('apiClient');
  const [rows, setRows] = useState<ApiRequestHistory[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (requestId == null || requestId < 0) { setRows([]); return; }
    let alive = true;
    setLoading(true);
    listRequestHistory(projectId, requestId)
      .then((h) => { if (alive) setRows(h); })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, requestId, refreshToken]);

  const empty =
    requestId == null
      ? t('timeline.selectRequest')
      : loading
        ? t('timeline.loading')
        : t('timeline.noSends');

  if (rows.length === 0) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground px-3 text-center">{empty}</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-auto text-xs">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 px-2 py-1.5 border-b border-border/40">
          <StatusBadge status={r.status} />
          <span className="text-muted-foreground tabular-nums w-14 shrink-0">
            {r.duration_ms != null ? `${r.duration_ms}ms` : '—'}
          </span>
          <span
            className="flex-1 min-w-0 truncate font-mono text-[10.5px]"
            title={r.error ?? r.url ?? ''}
          >
            <span className={r.error ? 'text-red-500' : 'text-foreground'}>{r.error ?? r.url ?? ''}</span>
          </span>
          <span className="text-muted-foreground/60 shrink-0 tabular-nums">{timePart(r.created_at)}</span>
        </div>
      ))}
    </div>
  );
}
