import type { QaTestPlan, QaTestResult } from '@mcp/services/qa/types.js';
import { parseTestPlanSections } from '@mcp/services/qa/parsers/parse-test-plan.js';
import { matchPlanToResults, type AnnotatedSection } from '@mcp/services/qa/parsers/match-plan-to-results.js';
import { fetchRunDetail } from '../api/qa-api.js';

export function annotateTestPlan(plan: QaTestPlan, results: QaTestResult[]): AnnotatedSection[] {
  if (!plan.exists) return [];
  if (plan.source !== 'preview') return matchPlanToResults(parseTestPlanSections(plan.content).sections, results);
  // Preview criteria and results have exact, stable names. A substring match
  // could incorrectly mark a different criterion as passed.
  const byName = new Map<string, QaTestResult>();
  for (const result of results) if (!byName.has(result.test_name)) byName.set(result.test_name, result);
  return [{ heading: plan.title ?? '', priority: null, scenarios: (plan.criteria ?? []).map(criterion => {
    const result = byName.get(criterion.name);
    return { text: criterion.name, verdict: result?.status ?? 'not-run', resultId: result?.id ?? null };
  }) }];
}

export async function loadTestPlan(sessionId: string, serviceId: string, signal: AbortSignal) {
  const query = new URLSearchParams({ service: serviceId });
  const response = await fetch(`/api/company/sessions/${sessionId}/qa/test-plan?${query}`, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${await response.text()}`);
  const plan = await response.json() as QaTestPlan;
  let results: QaTestResult[] = [];
  let resultsUnavailable = false;
  if (plan.exists && plan.run_id) {
    try { results = [...(await fetchRunDetail({ sessionId, runId: plan.run_id, signal })).results].reverse(); }
    catch (error) { if (signal.aborted) throw error; resultsUnavailable = true; }
  }
  return { plan, sections: annotateTestPlan(plan, results), resultsUnavailable };
}
