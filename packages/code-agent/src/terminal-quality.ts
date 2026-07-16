/** Terminal-only Quality dispatch. Internal turns and subagents never reach the provider. */
import {
  recordGlobalDeterministicQualitySignal,
  runGlobalQualityClassifiers,
  type AgentOutputForClassification,
  type QualityResult,
} from '@mcp/services/quality/index.js';
import type { StopReason } from './core/runner/types.js';

export interface TerminalQualityInput extends Omit<AgentOutputForClassification,
  'messageId' | 'parentRunId' | 'isSubagent' | 'subagentProfile' | 'stopReason'> {
  reason: StopReason;
  isSubagent: boolean;
}

export interface TerminalQualityDeps {
  assess(output: AgentOutputForClassification): Promise<QualityResult | null>;
  recordMissingFinal(input: Parameters<typeof recordGlobalDeterministicQualitySignal>[0]): string | null;
}

const defaultDeps: TerminalQualityDeps = {
  assess: runGlobalQualityClassifiers,
  recordMissingFinal: recordGlobalDeterministicQualitySignal,
};

export async function runTerminalQualityAssessment(
  input: TerminalQualityInput,
  deps: TerminalQualityDeps = defaultDeps,
): Promise<'skipped' | 'missing_final' | 'assessed' | 'disabled'> {
  if (input.reason !== 'completed' || input.isSubagent || input.roundMessageId == null) {
    return 'skipped';
  }
  if (!input.outputText.trim()) {
    deps.recordMissingFinal({
      sessionId: input.sessionId ?? null,
      companySessionId: input.companySessionId ?? null,
      agentRunId: input.agentRunId ?? null,
      coderRunId: input.coderRunId ?? null,
      roundMessageId: input.roundMessageId,
      classifierName: 'delivery_overall',
      verdict: 'flagged',
      reason: 'Completed round has no final response text.',
      scope: 'run_final',
      actionTaken: 'advisory',
      evidence: {
        stopReason: input.reason,
        changedFiles: input.changedFiles ?? [],
        toolSummary: input.toolSummary ?? null,
        guardActions: input.guardActions ?? [],
        validationSignals: input.validationSignals ?? [],
      },
    });
    return 'missing_final';
  }
  const { reason, isSubagent: _isSubagent, ...output } = input;
  const result = await deps.assess({
    ...output,
    stopReason: reason,
    messageId: `round-${input.roundMessageId}`,
    parentRunId: null,
    isSubagent: false,
    subagentProfile: null,
  });
  return result ? 'assessed' : 'disabled';
}
