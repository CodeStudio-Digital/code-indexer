/**
 * Detail inicial + eventos duráveis do workflow. O SSE invalida a leitura
 * somente quando algo mudou, sem varrer toda a sessão a cada cinco segundos.
 */
import { useCallback, useEffect, useState } from 'react';
import { getAppStudioSession, type AppStudioSessionDetail } from './app-studio-api.js';

export function useAppStudioSession(sessionId: number): {
  detail: AppStudioSessionDetail | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [detail, setDetail] = useState<AppStudioSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await getAppStudioSession(sessionId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const events = new EventSource(`/api/app-studio/sessions/${sessionId}/events`);
    const changed = (event: MessageEvent) => {
      if (event.type !== 'heartbeat') void refresh();
    };
    const eventNames = [
      'workflow.migrated', 'work_item.upserted', 'work_item.status_changed',
      'work_item.reordered', 'approval.requested', 'approval.resolved',
      'decision.requested', 'decision.resolved', 'blueprint.saved',
      'publish.completed', 'agents.coordinator_changed',
    ];
    eventNames.forEach((name) => events.addEventListener(name, changed));
    events.onerror = () => setError((current) => current ?? 'A conexão ao workflow será retomada automaticamente.');
    return () => {
      eventNames.forEach((name) => events.removeEventListener(name, changed));
      events.close();
    };
  }, [refresh, sessionId]);

  return { detail, error, refresh };
}
