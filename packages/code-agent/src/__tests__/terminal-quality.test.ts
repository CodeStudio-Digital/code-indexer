import { describe, expect, it, vi } from 'vitest';
import { runTerminalQualityAssessment, type TerminalQualityDeps } from '../terminal-quality.js';
import type { AgentOutputForClassification } from '@mcp/services/quality/index.js';

function deps() {
  const assess = vi.fn(async (_output: AgentOutputForClassification) => ({
    verdicts: [], worstVerdict: 'ok' as const, durationMs: 1, assessmentId: 'assessment-1',
  }));
  const recordMissingFinal = vi.fn(() => 'signal-1');
  return { assess, recordMissingFinal } satisfies TerminalQualityDeps;
}

const base = {
  reason: 'completed' as const,
  isSubagent: false,
  sessionId: 1,
  coderRunId: 'run-1',
  roundMessageId: 41,
  taskText: 'Explain the payment system',
  outputText: 'The final, evidence-backed explanation.',
};

describe('runTerminalQualityAssessment', () => {
  it('makes no request for nine internal cycles and exactly one after completion', async () => {
    const d = deps();
    for (let turn = 0; turn < 9; turn++) {
      await runTerminalQualityAssessment({
        ...base,
        reason: 'max_turns',
        outputText: 'Vou verificar achados anteriores antes de abrir novas trilhas.',
      }, d);
    }
    expect(d.assess).not.toHaveBeenCalled();

    expect(await runTerminalQualityAssessment(base, d)).toBe('assessed');
    expect(d.assess).toHaveBeenCalledTimes(1);
    expect(d.assess.mock.calls[0][0]).toMatchObject({
      roundMessageId: 41,
      stopReason: 'completed',
      messageId: 'round-41',
      isSubagent: false,
    });
  });

  it('skips aborted runs, subagents and rounds without an id', async () => {
    const d = deps();
    expect(await runTerminalQualityAssessment({ ...base, reason: 'aborted' }, d)).toBe('skipped');
    expect(await runTerminalQualityAssessment({ ...base, isSubagent: true }, d)).toBe('skipped');
    expect(await runTerminalQualityAssessment({ ...base, roundMessageId: null }, d)).toBe('skipped');
    expect(d.assess).not.toHaveBeenCalled();
  });

  it('records missing final text deterministically without calling the provider', async () => {
    const d = deps();
    expect(await runTerminalQualityAssessment({ ...base, outputText: '   ' }, d)).toBe('missing_final');
    expect(d.assess).not.toHaveBeenCalled();
    expect(d.recordMissingFinal).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'run_final',
      actionTaken: 'advisory',
      classifierName: 'delivery_overall',
    }));
  });
});
