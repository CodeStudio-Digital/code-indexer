import type { VerifyEvidence } from '@mcp/code-agent/core/review-evidence.js';
import type { ToolCallLedgerEntry } from '@mcp/code-agent/core/tool-call-ledger.js';
import { resolveToolMetadata } from '@mcp/code-agent/core/policy.js';
import { isPlainDocumentationPath, validationTargetsDocumentation } from '@mcp/code-agent/core/documentation-write.js';
import type { RunContext } from '../machine/types.js';

export type VerificationReadinessStatus =
  | 'not_applicable'
  | 'fresh'
  | 'missing'
  | 'stale'
  | 'ambiguous';

export interface VerificationReadiness {
  status: VerificationReadinessStatus;
  changedFiles: string[];
  lastWriteSeq: number | null;
  lastValidationSeq: number | null;
  lastSuccessfulValidationSeq: number | null;
  validationSignals: string[];
  persisted: VerifyEvidence | null;
  source: 'none' | 'ledger' | 'persisted';
}

export interface VerificationGateOptions {
  maxNudges?: number;
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

function persistedReadiness(
  changedFiles: string[],
  persisted: VerifyEvidence | null,
): VerificationReadiness {
  const base = {
    changedFiles,
    lastWriteSeq: null,
    lastValidationSeq: null,
    lastSuccessfulValidationSeq: null,
    validationSignals: [],
    persisted,
    source: 'persisted' as const,
  };
  if (!persisted?.lastVerify) return { ...base, status: 'missing' };
  if (persisted.lastVerify.isError || (persisted.lastVerify.exitCode != null && persisted.lastVerify.exitCode !== 0)) {
    return { ...base, status: 'stale' };
  }
  if (persisted.lastVerify.exitCode == null) return { ...base, status: 'ambiguous' };
  const affectsCheck = (file: string) => persisted.lastVerify!.includesDocumentation
    || validationTargetsDocumentation(persisted.lastVerify!.command) || !isPlainDocumentationPath(file);
  if (persisted.filesEditedAfter.some(affectsCheck)) return { ...base, status: 'stale' };
  if (persisted.filesEditedAtSameTime?.some(affectsCheck)) return { ...base, status: 'ambiguous' };
  return { ...base, status: 'fresh' };
}

export async function evaluateVerificationReadinessAtFinish(
  ctx: RunContext,
): Promise<VerificationReadiness> {
  const entries = currentRunEntries(ctx);
  const validations = entries.filter((entry) => !!entry.validationSignal);
  const checksDocumentation = validations.some(entry => validationTargetsDocumentation(entry.validationSignal!));
  const writes = entries.filter((entry) => isWriteEntry(ctx, entry, checksDocumentation));
  const successfulValidations = validations.filter((entry) => entry.outcome === 'success' && entry.validationOutcome === 'passed');
  const changedFiles = (() => {
    try {
      return [...(ctx.bridge?.getSessionStateData?.()?.filesChanged ?? [])];
    } catch {
      return [];
    }
  })();
  const lastWriteSeq = maxSeq(writes);
  const lastValidationSeq = maxSeq(validations);
  const lastSuccessfulValidationSeq = maxSeq(successfulValidations);
  const lastSuccessfulValidationStartSeq = successfulValidations.at(-1)?.validationStartedSeq ?? null;
  const validationSignals = uniqueSignals(validations);

  if (!changedFiles.some(file => !isPlainDocumentationPath(file)) && lastWriteSeq == null && lastValidationSeq == null) {
    return {
      status: 'not_applicable',
      changedFiles,
      lastWriteSeq,
      lastValidationSeq,
      lastSuccessfulValidationSeq,
      validationSignals,
      persisted: null,
      source: 'none',
    };
  }

  if (lastWriteSeq != null || lastValidationSeq != null) {
    const status: VerificationReadinessStatus = lastWriteSeq != null
      ? lastSuccessfulValidationStartSeq != null && lastSuccessfulValidationStartSeq > lastWriteSeq
        && lastSuccessfulValidationSeq === lastValidationSeq
        ? 'fresh'
        : lastValidationSeq != null
          ? 'stale'
          : 'missing'
      : lastSuccessfulValidationSeq === lastValidationSeq
        ? 'fresh'
        : 'stale';
    return {
      status,
      changedFiles,
      lastWriteSeq,
      lastValidationSeq,
      lastSuccessfulValidationSeq,
      validationSignals,
      persisted: null,
      source: 'ledger',
    };
  }

  let persisted: VerifyEvidence | null = null;
  try {
    persisted = (await ctx.opts.collectVerifyEvidence?.()) ?? null;
  } catch {
    persisted = null;
  }
  return persistedReadiness(changedFiles, persisted);
}

export function maybeVerificationNudge(
  ctx: RunContext,
  readiness: VerificationReadiness,
  options: VerificationGateOptions = {},
): string | null {
  const maxNudges = Math.max(0, options.maxNudges ?? 1);
  if (
    ctx.verification.nudges >= maxNudges
    || readiness.lastWriteSeq == null
    || readiness.status === 'fresh'
    || readiness.status === 'not_applicable'
  ) {
    return null;
  }

  ctx.verification.nudges += 1;
  const instruction = readiness.status === 'missing'
    ? 'No validation was recorded after the latest write.'
    : 'The recorded validation failed, is stale, or does not clearly cover the latest write.';
  return (
    `[verification-required] ${instruction} ` +
    'Run the smallest relevant test, typecheck, lint, or build now. ' +
    'If validation is impossible, say why and do not claim that it passed.'
  );
}
