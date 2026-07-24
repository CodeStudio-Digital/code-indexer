import type { VerifyEvidence } from '@mcp/code-agent/core/review-evidence.js';
import type { ToolCallLedgerEntry } from '@mcp/code-agent/core/tool-call-ledger.js';
import { resolveToolMetadata } from '@mcp/code-agent/core/policy.js';
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

function isWriteEntry(ctx: RunContext, entry: ToolCallLedgerEntry): boolean {
  if (entry.outcome !== 'success') return false;
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
  if (persisted.filesEditedAfter.length > 0) return { ...base, status: 'stale' };
  if ((persisted.filesEditedAtSameTime?.length ?? 0) > 0) return { ...base, status: 'ambiguous' };
  return { ...base, status: 'fresh' };
}

export function evaluateVerificationReadinessAtFinish(ctx: RunContext): VerificationReadiness {
  const entries = currentRunEntries(ctx);
  const writes = entries.filter((entry) => isWriteEntry(ctx, entry));
  const validations = entries.filter((entry) => !!entry.validationSignal);
  const successfulValidations = validations.filter((entry) => entry.outcome === 'success');
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
  const validationSignals = uniqueSignals(validations);

  if (changedFiles.length === 0 && lastWriteSeq == null) {
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
      ? lastSuccessfulValidationSeq != null && lastSuccessfulValidationSeq > lastWriteSeq
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
    persisted = ctx.opts.collectVerifyEvidence?.() ?? null;
  } catch {
    persisted = null;
  }
  return persistedReadiness(changedFiles, persisted);
}

export function formatVerificationReadiness(readiness: VerificationReadiness): string {
  const signals = readiness.validationSignals.length > 0
    ? ` Validation seen: ${readiness.validationSignals.join(', ')}.`
    : '';
  const files = readiness.changedFiles.slice(0, 8);
  const fileText = files.length > 0
    ? ` Changed files: ${files.join(', ')}${readiness.changedFiles.length > files.length ? ' (+more)' : ''}.`
    : '';
  switch (readiness.status) {
    case 'fresh':
      return `Verification is fresh and covers the latest recorded write.${signals}${fileText}`;
    case 'stale':
      return `Verification is stale or failed; it does not cover the latest recorded write.${signals}${fileText}`;
    case 'ambiguous':
      return `Verification freshness is ambiguous because a write and validation share the persisted timestamp.${fileText}`;
    case 'missing':
      return `No successful test/typecheck/lint/build was recorded after the latest change.${fileText}`;
    case 'not_applicable':
      return 'No changed files or current-run writes were recorded; verification is not applicable.';
  }
}

export function maybeVerificationNudge(
  ctx: RunContext,
  readiness: VerificationReadiness,
  options: VerificationGateOptions = {},
): string | null {
  if (readiness.status === 'not_applicable' || readiness.status === 'fresh') return null;
  const maxNudges = options.maxNudges ?? 1;
  if (ctx.verification.nudges >= maxNudges) return null;
  ctx.verification.nudges += 1;
  return (
    '<system-reminder>Completion evidence is not fresh. ' +
    formatVerificationReadiness(readiness) +
    ' Before saying the work is done, run the applicable project validation. ' +
    'If no executable oracle applies (for example a prose-only change), state that limitation explicitly in the final summary.</system-reminder>'
  );
}

/**
 * Apply the same bounded evidence policy before update_goal persists a
 * completion. Without this dispatch boundary, an early completion can strand
 * the following validation behind the goal gate because the durable goal is
 * already complete. This is intentionally reversible after the shared nudge
 * budget, matching the text-finish gate for work with no executable oracle.
 */
export function maybeVerificationCompletionRefusal(ctx: RunContext): string | null {
  let goal: ReturnType<NonNullable<typeof ctx.opts.toolContext.getGoalState>>;
  try {
    goal = ctx.opts.toolContext.getGoalState?.() ?? null;
  } catch {
    // Goal persistence owns its own precise read error. Do not mask it with a
    // secondary verification refusal.
    return null;
  }
  if (goal?.status !== 'in_progress') return null;

  const readiness = evaluateVerificationReadinessAtFinish(ctx);
  const nudge = maybeVerificationNudge(ctx, readiness);
  if (!nudge) return null;
  return (
    '[verification-evidence] Refused `update_goal`: completion evidence is not fresh. ' +
    formatVerificationReadiness(readiness) +
    ' Run the applicable validation, then retry update_goal. If no executable oracle applies, ' +
    'retry once and state that limitation explicitly in the final summary.'
  );
}
