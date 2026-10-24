import { useCallback, useEffect, useState } from 'react';
import type { PreflightReport } from '@mcp/api-bus';
import { apiCall } from '../../lib/api-client.js';

type PreflightStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Runs `system.preflight` on mount and on demand (Re-check). */
export function usePreflight() {
  const [status, setStatus] = useState<PreflightStatus>('idle');
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recheck = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const r = await apiCall<PreflightReport>('system.preflight');
      setReport(r);
      setStatus('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  return { status, report, error, recheck };
}
