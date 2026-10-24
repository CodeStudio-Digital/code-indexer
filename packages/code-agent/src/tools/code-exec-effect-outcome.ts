import { unknownToolOutcome, type ToolResult } from '../core/tool.js';
import type { ToolCallLedger } from '../core/tool-call-ledger.js';

/** Catching a script error or receiving a late ACK cannot reconcile a mutation. */
export function preserveCodeExecEffectOutcome(result: ToolResult, ledger: ToolCallLedger): ToolResult {
  if (!ledger.outcomeUnknownTool) return result;
  const unknown = unknownToolOutcome(
    `The effect of ${ledger.outcomeUnknownTool} is unconfirmed. Reconcile it before another invocation.\n\n${result.content}`,
  );
  const data = result.structuredData;
  return { ...result, ...unknown,
    ...(data && typeof data === 'object' && !Array.isArray(data) ? {
      structuredData: { ...data, effectOutcome: 'unknown', error: unknown.error },
    } : {}),
  };
}
