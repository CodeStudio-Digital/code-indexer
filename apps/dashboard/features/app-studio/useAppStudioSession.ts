/**
 * Detail inicial + eventos duráveis do workflow. O SSE invalida a leitura
 * somente quando algo mudou, sem varrer toda a sessão a cada cinco segundos.
 */
import { useCallback, useEffect, useState } from 'react';
import { getAppStudioSession, type AppStudioSessionDetail } from './app-studio-api.js';

export function latestAppStudioEventSeq(detail: AppStudioSessionDetail): number {
  return (detail.recent_events ?? []).reduce(
    (latest, event) => Math.max(latest, event.seq),
    0,
  );
}

export function appStudioEventsUrl(sessionId: string, afterSeq: number): string {
  return `/api/app-studio/apps/${sessionId}/events?after=${afterSeq}`;
}

export function useAppStudioSession(sessionId: string): {
  detail: AppStudioSessionDetail | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [detail, setDetail] = useState<AppStudioSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamSeed, setStreamSeed] = useState<{ sessionId: string; seq: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getAppStudioSession(sessionId);
      setDetail(next);
      setStreamSeed((current) => current?.sessionId === sessionId
        ? current
        : { sessionId, seq: latestAppStudioEventSeq(next) });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (streamSeed?.sessionId !== sessionId) return;
    let cursor = streamSeed.seq;
    const events = new EventSource(appStudioEventsUrl(sessionId, cursor));
    const changed = (event: MessageEvent) => {
      const eventSeq = Number(event.lastEventId);
      if (Number.isSafeInteger(eventSeq) && eventSeq > cursor) cursor = eventSeq;
      if (event.type !== 'heartbeat') void refresh();
    };
    const eventNames = [
      'plan.revised', 'plan.approval_requested', 'plan.approved',
      'work.status', 'decision.requested', 'decision.resolved', 'decision.coordination_failed',
      'agents.specialist_dispatched', 'agents.unbound_claim_recovered',
      'agents.run_without_evidence', 'agents.run_recovered_after_restart', 'agents.run_failed',
      'agents.duplicate_run_cancelled',
      'database.changed', 'database.provisioned', 'deployment.publishing',
      'deployment.live', 'deployment.failed', 'team.config_updated',
      'build.paused', 'build.resumed', 'build.cancelled', 'build.scheduler_resume_failed',
    ];
    eventNames.forEach((name) => events.addEventListener(name, changed));
    events.onerror = () => setError((current) => current ?? 'A conexão ao workflow será retomada automaticamente.');
    return () => {
      eventNames.forEach((name) => events.removeEventListener(name, changed));
      events.close();
    };
  }, [refresh, sessionId, streamSeed]);

  return { detail, error, refresh };
}
