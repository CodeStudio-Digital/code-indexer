/**
 * Polling do detail da sessão App Studio (5s, visibility-aware) — mesmo
 * padrão do DsStudioView. O detail alimenta Guia/GuideBar/Dados/Publicar.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePolling } from '../../hooks/usePolling.js';
import { getAppStudioSession, type AppStudioSessionDetail } from './app-studio-api.js';

const REFRESH_INTERVAL_MS = 5_000;

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
  usePolling(() => void refresh(), REFRESH_INTERVAL_MS, { immediate: false });

  return { detail, error, refresh };
}
