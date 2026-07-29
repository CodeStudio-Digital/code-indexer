import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import {
  evictCompanyOrchestrator,
  getCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import type { CompanySessionId } from '@mcp/session-storage';

export type AbortCompanyRuntimeResult =
  | { ok: true }
  | { ok: false; reason: 'not_active' }
  | {
      ok: false;
      reason: 'outcome_unknown';
      code: 'OUTCOME_UNKNOWN';
      error: string;
    };

/**
 * Abort the live runtime behind a Company session.
 *
 * Route ownership is intentionally handled by the caller: the generic
 * Company control plane rejects App-owned teams, while the App facade first
 * proves the App -> Company binding and may then call this same lifecycle
 * primitive. Keeping the actual abort here prevents the two HTTP surfaces
 * from drifting.
 */
export async function abortCompanyRuntime(
  companySessionId: CompanySessionId,
): Promise<AbortCompanyRuntimeResult> {
  const orchestrator = getCompanyOrchestrator(companySessionId);
  if (!orchestrator) return { ok: false, reason: 'not_active' };
  try {
    await orchestrator.abortAll();
  } catch (error) {
    // A timeout/closed port does not cancel the worker-side abort. Fence the
    // executor before reporting the ambiguity and never replay the RPC.
    await evictCompanyOrchestrator(companySessionId);
    if (isMutationOutcomeUnknownError(error)) {
      return {
        ok: false,
        reason: 'outcome_unknown',
        code: 'OUTCOME_UNKNOWN',
        error: (
          typeof error === 'object'
          && error !== null
          && typeof (error as { message?: unknown }).message === 'string'
        )
          ? (error as { message: string }).message
          : String(error),
      };
    }
    throw error;
  }
  await evictCompanyOrchestrator(companySessionId);
  return { ok: true };
}
