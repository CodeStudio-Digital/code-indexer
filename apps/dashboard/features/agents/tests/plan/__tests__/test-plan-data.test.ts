import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QaTestPlan, QaTestResult } from '@mcp/services/qa/types.js';
const detail = vi.hoisted(() => vi.fn());
vi.mock('../../api/qa-api.js', () => ({ fetchRunDetail: detail }));
import { annotateTestPlan, loadTestPlan } from '../test-plan-data.js';
const plan: QaTestPlan = { exists: true, source: 'preview', content: '## Contract', title: 'Contrato', run_id: 'chosen-run',
  criteria: [{ name: 'Salvar', selector: 'button' }, { name: 'Salvar contrato', selector: 'button.save' }] };
const result = { id: 'result', test_name: 'Salvar contrato', status: 'passed' } as QaTestResult;
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });
describe('preview QA plan projection', () => {
  it('never gives one criterion the verdict of another with a similar name', () => {
    expect(annotateTestPlan(plan, [result])[0]?.scenarios.map(scenario => scenario.verdict)).toEqual(['not-run', 'passed']);
  });
  it('requests only the selected service plan and the run identified by that plan', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(plan)); vi.stubGlobal('fetch', fetch);
    detail.mockResolvedValue({ results: [result] });
    const signal = new AbortController().signal;
    const data = await loadTestPlan('session', 'api', signal);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/company/sessions/session/qa/test-plan?service=api', { signal });
    expect(detail).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session', runId: 'chosen-run', signal });
    expect(data.sections[0]?.scenarios[1]?.verdict).toBe('passed');
  });
  it('does not fetch unrelated history for an empty plan', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ exists: false, content: '', source: 'none' })); vi.stubGlobal('fetch', fetch);
    expect((await loadTestPlan('session', 'main', new AbortController().signal)).sections).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1); expect(detail).not.toHaveBeenCalled();
  });
  it('keeps the plan and reports unavailable results without inventing success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(plan)));
    detail.mockRejectedValue(new Error('offline'));
    const data = await loadTestPlan('session', 'main', new AbortController().signal);
    expect(data.plan).toEqual(plan); expect(data.resultsUnavailable).toBe(true);
    expect(data.sections[0]?.scenarios.every(scenario => scenario.verdict === 'not-run')).toBe(true);
  });
  it('propagates cancellation while loading a result instead of publishing stale data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(plan)));
    const controller = new AbortController();
    detail.mockImplementation(async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); });
    await expect(loadTestPlan('session', 'main', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('retains legacy Markdown sections and their recorded result mapping', () => {
    const legacy: QaTestPlan = { exists: true, content: '### Fluxo (P0)\n- Salvar contrato', source: 'sandbox' };
    expect(annotateTestPlan(legacy, [result])[0]).toMatchObject({ heading: 'Fluxo (P0)', scenarios: [{ text: 'Salvar contrato', verdict: 'passed' }] });
  });
});
