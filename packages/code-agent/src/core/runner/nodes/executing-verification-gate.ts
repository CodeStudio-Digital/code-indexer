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

export type GoalCompletionHealth =
  | 'verified'
  | 'unverified'
  | 'completed_with_warnings';

export interface GoalCompletionAdvisory {
  health: GoalCompletionHealth;
  text: string;
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

export async function evaluateVerificationReadinessAtFinish(
  ctx: RunContext,
): Promise<VerificationReadiness> {
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
    persisted = (await ctx.opts.collectVerifyEvidence?.()) ?? null;
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

/**
 * Classify completion evidence without granting it execution authority.
 * `update_goal(status="complete")` persists first; this health is then shown
 * in the tool result and written to the session audit trail.
 */
export function buildGoalCompletionAdvisory(
  readiness: VerificationReadiness,
): GoalCompletionAdvisory {
  const health: GoalCompletionHealth =
    readiness.status === 'fresh'
      ? 'verified'
      : readiness.status === 'not_applicable'
        ? 'unverified'
        : 'completed_with_warnings';
  return {
    health,
    text:
      `[goal-advisory] Completion health: ${health}. ` +
      formatVerificationReadiness(readiness) +
      ' Goal completion was persisted; verification evidence is advisory and cannot block it.',
  };
}

/**
 * @deprecated Verification no longer intercepts a clean finish.
 */
export function maybeVerificationNudge(
  _ctx: RunContext,
  _readiness: VerificationReadiness,
  _options: VerificationGateOptions = {},
): string | null {
  return null;
}

/**
 * @deprecated Verification no longer refuses update_goal completion.
 */
export function maybeVerificationCompletionRefusal(_ctx: RunContext): string | null {
  return null;
}
