import type { PendingToolApproval, ToolApprovalRecovery, ToolApprovalVerdict } from './types.js';

/** Do not offer review of a partial or malformed host incident set. */
export function parseToolApprovalRecovery(value: unknown): ToolApprovalRecovery | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { fingerprint, incidents } = value as Partial<ToolApprovalRecovery>;
  if (typeof fingerprint !== 'string' || !fingerprint.trim()
    || !Array.isArray(incidents) || incidents.length === 0) return undefined;
  const ids = new Set<string>();
  for (const incident of incidents) {
    if (!incident || typeof incident !== 'object'
      || typeof incident.toolUseId !== 'string' || !incident.toolUseId.trim()
      || ids.has(incident.toolUseId)
      || (incident.toolName !== undefined && typeof incident.toolName !== 'string')
      || (incident.argsSummary !== undefined && typeof incident.argsSummary !== 'string')) return undefined;
    ids.add(incident.toolUseId);
  }
  return { fingerprint, incidents };
}

export function toolApprovalVerdict(
  approval: PendingToolApproval,
  approved: boolean,
  options: { note: string; alwaysAllow: boolean; recoveryReviewed: boolean },
): ToolApprovalVerdict {
  const review = approved && approval.approvalKind === 'outcome_recovery'
    && options.recoveryReviewed && approval.recovery;
  return {
    approved,
    note: options.note.trim() || undefined,
    alwaysAllow: approved && options.alwaysAllow && approval.approvalKind !== 'outcome_recovery' ? true : undefined,
    ...(review ? { recoveryReviewed: true, recoveryFingerprint: review.fingerprint } : {}),
  };
}

export function toolApprovalResponseBody(toolUseId: string, verdict: ToolApprovalVerdict) {
  const reviewed = verdict.approved && verdict.recoveryReviewed === true
    && typeof verdict.recoveryFingerprint === 'string' && verdict.recoveryFingerprint.trim().length > 0;
  return {
    tool_use_id: toolUseId,
    approved: verdict.approved,
    note: verdict.note,
    always_allow: verdict.approved && !reviewed ? verdict.alwaysAllow : undefined,
    ...(reviewed ? { recovery_reviewed: true, recovery_fingerprint: verdict.recoveryFingerprint } : {}),
  };
}
