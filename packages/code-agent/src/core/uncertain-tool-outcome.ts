import type { AgentMessage } from './messages.js';

/** Inspect typed host evidence, never strings returned by an untrusted tool. */
export function unresolvedToolOutcome(messages: readonly AgentMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.effect_outcome === 'unknown') return block.tool_use_id;
    }
  }
  return undefined;
}

export function uncertainToolOutcomeError(toolUseId: string): Error {
  return Object.assign(new Error(`TOOL_OUTCOME_UNKNOWN: ${toolUseId} may have taken effect. Automatic continuation is blocked until the original operation is reconciled.`), { code: 'TOOL_OUTCOME_UNKNOWN' as const });
}


export function isUncertainToolOutcomeError(error: unknown): error is Error & { code: 'TOOL_OUTCOME_UNKNOWN' } {
  return error instanceof Error && (error as Error & { code?: string }).code === 'TOOL_OUTCOME_UNKNOWN';
}
