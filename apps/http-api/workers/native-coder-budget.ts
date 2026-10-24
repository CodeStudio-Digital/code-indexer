import type { ExecutionBudgetPolicyV1 } from '@mcp/agent-runtime-contracts';

export interface NativeCoderExecutionBudget {
  readonly deadlineAtUnixMs: number;
  readonly executionDeadlineAtUnixMs: number;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
}
/** Immutable execution budget; renewable executor authority is enforced separately. */
export function nativeCoderExecutionBudget(input: {
  maxTurns: number; policy?: ExecutionBudgetPolicyV1; executorExpiresAt: string; now?: number;
}): NativeCoderExecutionBudget {
  const now = input.now ?? Date.now();
  const expiry = Date.parse(input.executorExpiresAt);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiry) || expiry <= now + 1000) {
    throw new Error('Native execution requires a live executor lease');
  }
  const requestedTurns = limit('requested maxTurns', input.maxTurns, true);
  const policyTurns = limit('maxTurns', input.policy?.maxTurns);
  const maxToolCalls = limit('maxToolCalls', input.policy?.maxToolCalls);
  const wall = limit('maxWallMs', input.policy?.maxWallMs);
  // Reserve one second inside the sealed execution budget for terminal commit.
  // Provider and effects receive the earlier absolute execution deadline.
  const duration = wall ?? 24 * 60 * 60 * 1000;
  if (duration > 2_147_482_647 || !Number.isSafeInteger(now + duration + 1000)) {
    throw new Error('Invalid native execution budget: maxWallMs exceeds timer capacity');
  }
  const executionDeadlineAtUnixMs = now + duration;
  const deadlineAtUnixMs = executionDeadlineAtUnixMs + 1000;
  const maxTurns = requestedTurns === undefined ? policyTurns
    : policyTurns === undefined ? requestedTurns : Math.min(requestedTurns, policyTurns);
  return { deadlineAtUnixMs, executionDeadlineAtUnixMs, maxTurns, maxToolCalls };
}
function limit(name: string, value: number | null | undefined, zeroMeansUnbounded = false): number | undefined {
  if (value === undefined || value === null || (zeroMeansUnbounded && value === 0)) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid native execution budget: ' + name);
  return value;
}
