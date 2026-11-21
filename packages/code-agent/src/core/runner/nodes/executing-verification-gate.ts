import type { ToolCallLedgerEntry } from '@mcp/code-agent/core/tool-call-ledger.js';
import { resolveToolMetadata } from '@mcp/code-agent/core/policy.js';
import { validationTargetsDocumentation } from '@mcp/code-agent/core/documentation-write.js';
import type { RunContext } from '../machine/types.js';

export type VerificationReadinessStatus =
  | 'not_applicable'
  | 'fresh'
  | 'missing'
  | 'stale';

export interface VerificationReadiness {
  status: VerificationReadinessStatus;
  lastWriteSeq: number | null;
  lastValidationSeq: number | null;
  lastSuccessfulValidationSeq: number | null;
  validationSignals: string[];
  source: 'none' | 'ledger';
}

function currentRunEntries(ctx: RunContext): ToolCallLedgerEntry[] {
  return ctx.opts.toolContext.toolCallLedger?.snapshot(ctx.verification.ledgerStartSeq) ?? [];
}

function isWriteEntry(ctx: RunContext, entry: ToolCallLedgerEntry, checksDocumentation: boolean): boolean {
  if (entry.outcome !== 'success') return false;
  // Shell metadata is conservatively mutating even for test invocations and
  // empty polls. Their own verification receipts are not subsequent edits.
  if (entry.validationSignal) return false;
  if (entry.verificationObservation) return false;
  if (entry.documentationOnly && !checksDocumentation) return false;
  if (entry.executionClass === 'read' && entry.mutates === false) return false;
  if (entry.executionClass === 'write') return true;
  const tool = ctx.opts.registry.get?.(entry.name);
  if (!tool) return false;
  const metadata = resolveToolMetadata(tool);
  return metadata.mutates || metadata.executionClass === 'write';
}

function maxSeq(entries: ToolCallLedgerEntry[]): number | null {
  return entries.length > 0 ? Math.max(...entries.map((entry) => entry.seq)) : null;
}

function uniqueSignals(entries: ToolCallLedgerEntry[]): string[] {
  return [...new Set(entries
    .map((entry) => entry.validationSignal)
    .filter((signal): signal is string => !!signal))];
}

export function evaluateVerificationReadiness(ctx: RunContext): VerificationReadiness {
  const entries = currentRunEntries(ctx);
  const validations = entries.filter((entry) => !!entry.validationSignal);
  const checksDocumentation = validations.some(entry => validationTargetsDocumentation(entry.validationSignal!));
  const writes = entries.filter((entry) => isWriteEntry(ctx, entry, checksDocumentation));
  const successfulValidations = validations.filter((entry) => entry.outcome === 'success' && entry.validationOutcome === 'passed');
  const lastWriteSeq = maxSeq(writes);
  const lastValidationSeq = maxSeq(validations);
  const lastSuccessfulValidationSeq = maxSeq(successfulValidations);
  const lastSuccessfulValidationStartSeq = successfulValidations.at(-1)?.validationStartedSeq ?? null;
  const validationSignals = uniqueSignals(validations);

  let status: VerificationReadinessStatus = 'not_applicable';
  if (lastWriteSeq != null) {
    if (lastValidationSeq == null) status = 'missing';
    else if (lastSuccessfulValidationStartSeq != null && lastSuccessfulValidationStartSeq > lastWriteSeq
      && lastSuccessfulValidationSeq === lastValidationSeq) status = 'fresh';
    else status = 'stale';
  } else if (lastValidationSeq != null) {
    status = lastSuccessfulValidationSeq === lastValidationSeq ? 'fresh' : 'stale';
  }
  return {
    status,
    lastWriteSeq,
    lastValidationSeq,
    lastSuccessfulValidationSeq,
    validationSignals,
    source: status === 'not_applicable' ? 'none' : 'ledger',
  };
}

export function renderVerificationReminder(readiness: VerificationReadiness): string | null {
  if (readiness.lastWriteSeq == null || (readiness.status !== 'missing' && readiness.status !== 'stale')) {
    return null;
  }
  const evidence = readiness.status === 'missing'
    ? 'No validation was recorded after the latest write.'
    : 'The recorded validation failed, is stale, or does not clearly cover the latest write.';
  return `${evidence} If verification is relevant to the request, run the smallest relevant check before the final reply. `
    + 'Report only checks actually run.';
}
