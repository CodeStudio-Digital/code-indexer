/**
 * Hook: fetch the workspace's `tests/e2e/TEST_PLAN.md` and parse it into
 * sections. Cross-references with the latest run's results to annotate
 * each scenario with a verdict (passed / failed / not-run / …).
 *
 * Lightweight — refreshes once on mount + on demand. Editor support
 * (PUT) is exposed via `save` so the future inline editor can wire to
 * the same hook.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseTestPlanSections } from '@mcp/services/qa/parsers/parse-test-plan.js';
import {
  matchPlanToResults,
  type AnnotatedSection,
} from '@mcp/services/qa/parsers/match-plan-to-results.js';
import { fetchActiveRun, fetchRuns, fetchRunDetail } from '../api/qa-api.js';
import type { QaTestResult } from '../shared/types.js';

interface FetchPlanResult {
  exists: boolean;
  content: string;
}

export interface UseTestPlanResult {
  loading: boolean;
  error: string | null;
  exists: boolean;
  content: string;
  sections: AnnotatedSection[];
  refresh: () => Promise<void>;
  save: (next: string) => Promise<void>;
}

export function useTestPlan(sessionId: number): UseTestPlanResult {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [content, setContent] = useState('');
  const [results, setResults] = useState<QaTestResult[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [planRes, recentResults] = await Promise.all([
        getJson<FetchPlanResult>(`/api/company/sessions/${sessionId}/qa/test-plan`),
        fetchLatestResults(sessionId),
      ]);
      setExists(planRes.exists);
      setContent(planRes.content);
      setResults(recentResults);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (next: string) => {
      const res = await fetch(`/api/company/sessions/${sessionId}/qa/test-plan`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: next }),
      });
      if (!res.ok) throw new Error(await safeText(res));
      setContent(next);
      setExists(true);
    },
    [sessionId],
  );

  const sections = exists
    ? matchPlanToResults(parseTestPlanSections(content).sections, results)
    : [];

  return { loading, error, exists, content, sections, refresh, save };
}

/**
 * Pull the freshest results we can find: prefer the active run's rows,
 * fall back to the most recent completed run's. Either gives us enough
 * signal to annotate scenario verdicts.
 */
async function fetchLatestResults(sessionId: number): Promise<QaTestResult[]> {
  try {
    const active = await fetchActiveRun(sessionId);
    if (active.run && active.results && active.results.length > 0) {
      return [...active.results].reverse(); // newest first
    }
  } catch {
    /* swallow — try history fallback */
  }
  try {
    const { runs } = await fetchRuns({ sessionId, limit: 1 });
    if (runs.length === 0) return [];
    const detail = await fetchRunDetail({ sessionId, runId: runs[0].id });
    return [...detail.results].reverse();
  } catch {
    return [];
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await safeText(res));
  return res.json() as Promise<T>;
}

async function safeText(res: Response): Promise<string> {
  try {
    return `${res.status} ${res.statusText} — ${await res.text()}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}
