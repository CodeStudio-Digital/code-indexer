/**
 * ServiceLogsPane — structured log viewer for one service (company B6).
 *
 * Two data sources merged into one ascending list:
 *   - REST backfill: `GET /services/:sid/logs/history` (paged via
 *     before_id — the "load earlier" button walks back).
 *   - Live tail: the bounded per-service buffer in `sandboxSlice`
 *     (`sandbox.service.log_batch` SSE → max 500 lines/service).
 *
 * Dedup between the two: persisted lines carry the SAME at_ms the live
 * event does (the supervisor persists before publishing), so live
 * entries with `atMs <= newest history at_ms` are already on screen via
 * REST and get dropped. Stream + text filters are client-side and apply
 * to both sources.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectSandbox, useCompanyStore } from '../../../state/company/index.js';
import type { ServiceLogEntry } from '../../../state/company/sandboxSlice.js';

interface HistoryLine {
  id: number;
  stream: string;
  line: string;
  at_ms: number;
}

export interface ServiceLogsPaneProps {
  sessionId?: number;
  serviceId?: string;
}

const PAGE_SIZE = 100;
const EMPTY_LIVE: ServiceLogEntry[] = [];
const STREAM_OPTIONS = ['all', 'devserver', 'container', 'scaffold'] as const;

function timeLabel(atMs: number): string {
  return new Date(atMs).toLocaleTimeString();
}

export function ServiceLogsPane({ sessionId, serviceId }: ServiceLogsPaneProps) {
  const { t } = useTranslation('agents');
  const [history, setHistory] = useState<HistoryLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [stream, setStream] = useState<(typeof STREAM_OPTIONS)[number]>('all');
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const live = useCompanyStore((s) =>
    sessionId != null && serviceId
      ? (selectSandbox(s, sessionId).serviceLogs[serviceId] ?? EMPTY_LIVE)
      : EMPTY_LIVE,
  );

  const fetchPage = useCallback(
    async (beforeId?: number) => {
      if (sessionId == null || !serviceId) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (beforeId) params.set('before_id', String(beforeId));
        const r = await fetch(
          `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/logs/history?${params}`,
        );
        if (!r.ok) return;
        const body = (await r.json()) as { lines?: HistoryLine[] };
        const page = (body.lines ?? []).slice().reverse(); // newest-first → ascending
        if (page.length < PAGE_SIZE) setExhausted(true);
        setHistory((prev) => (beforeId ? [...page, ...prev] : page));
      } catch {
        /* history is best-effort — live tail still works */
      } finally {
        setLoading(false);
      }
    },
    [sessionId, serviceId],
  );

  // Initial backfill per (session, service).
  useEffect(() => {
    setHistory([]);
    setExhausted(false);
    void fetchPage();
  }, [fetchPage]);

  // Live entries already present in the fetched history are dropped by
  // timestamp floor (see file header for why this is exact, not fuzzy).
  const maxHistoryAt = history.length > 0 ? history[history.length - 1].at_ms : 0;
  const merged = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string, ln: string) =>
      (stream === 'all' || s === stream) && (q === '' || ln.toLowerCase().includes(q));
    const rows: Array<{ key: string; atMs: number; stream: string; line: string; live: boolean }> = [];
    for (const h of history) {
      if (match(h.stream, h.line)) {
        rows.push({ key: `h${h.id}`, atMs: h.at_ms, stream: h.stream, line: h.line, live: false });
      }
    }
    for (const l of live) {
      if (l.atMs > maxHistoryAt && match(l.stream, l.line)) {
        rows.push({ key: `l${l.seq}`, atMs: l.atMs, stream: l.stream, line: l.line, live: true });
      }
    }
    return rows;
  }, [history, live, maxHistoryAt, stream, query]);

  // Follow the tail as new lines arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [merged.length]);

  const earliestId = history.length > 0 ? history[0].id : undefined;

  return (
    <div className="mt-1 rounded border bg-background/50">
      <div className="flex items-center gap-1 border-b px-1.5 py-1">
        <select
          className="h-5 rounded border bg-background px-1 text-[9px]"
          value={stream}
          onChange={(e) => setStream(e.target.value as (typeof STREAM_OPTIONS)[number])}
        >
          {STREAM_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt === 'all' ? t('services.logs.streamAll') : opt}
            </option>
          ))}
        </select>
        <input
          className="h-5 flex-1 min-w-0 rounded border bg-background px-1 text-[9px]"
          placeholder={t('services.logs.filterPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="flex items-center gap-1 text-[8px] text-muted-foreground uppercase tracking-wide">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {t('services.logs.live')}
        </span>
      </div>
      <div ref={scrollRef} className="max-h-44 overflow-y-auto px-1.5 py-1 font-mono text-[9px] leading-4">
        {!exhausted && earliestId !== undefined && (
          <button
            type="button"
            className="mb-1 w-full rounded border px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent"
            disabled={loading}
            onClick={() => void fetchPage(earliestId)}
          >
            {loading ? '…' : t('services.logs.loadEarlier')}
          </button>
        )}
        {merged.length === 0 && (
          <div className="py-1 text-muted-foreground">{t('services.logs.empty')}</div>
        )}
        {merged.map((row) => (
          <div key={row.key} className="whitespace-pre-wrap break-all">
            <span className="text-muted-foreground">{timeLabel(row.atMs)} </span>
            <span className={row.stream === 'container' ? 'text-sky-600' : 'text-muted-foreground'}>
              [{row.stream}]{' '}
            </span>
            {row.line}
          </div>
        ))}
      </div>
    </div>
  );
}
