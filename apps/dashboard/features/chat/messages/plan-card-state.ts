import type { PlanResolution } from '../../../hooks/useAgentStream.js';

export interface PlanToolResult {
  content: string;
  isError: boolean;
}

export type PersistedPlanStatus = 'pending' | 'approved' | 'rejected' | 'aborted';
export type PersistedPlanDisplayStatus = 'pending' | Exclude<PlanResolution, 'validation_error'>;

/**
 * Reconstruct the human-visible plan outcome from its tool result.
 *
 * `isError` is authoritative for distinguishing an internal/tool validation
 * failure from the legacy non-error "Plan rejected by user" result, which was
 * actually produced by the Revise button. Explicit user rejection is the only
 * error-shaped result that maps to a human decision.
 */
export function derivePlanResolution(result: PlanToolResult): PlanResolution {
  const content = result.content.trimStart();

  if (result.isError) {
    if (
      content.startsWith('Plan rejected by user.')
      || content.startsWith('Plan review aborted by user.')
    ) {
      return 'rejected';
    }
    return 'validation_error';
  }

  if (content.startsWith('Plan approved by user.')) return 'approved';
  if (
    content.startsWith('Plan revision requested by user.')
    || content.startsWith('Plan rejected by user.')
  ) {
    return 'revision_requested';
  }

  // A successful submit_plan result with an unknown shape must not be
  // attributed to the user. Treat it as an unclassified validation failure.
  return 'validation_error';
}

/** Map the legacy persisted vocabulary without rewriting historical rows. */
export function persistedPlanDisplayStatus(status: PersistedPlanStatus): PersistedPlanDisplayStatus {
  if (status === 'rejected') return 'revision_requested';
  if (status === 'aborted') return 'rejected';
  return status;
}
