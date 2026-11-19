/**
 * Format the tool_result content for a submit_spec response. Shared between
 * the live tool handler and any server-side resume path so a session resumed
 * after a restart produces the byte-identical message the runner would have
 * produced in-process.
 *
 * Mirrors `formatPlanResult` in `tools/plan.ts`.
 */
export function formatSpecResult(
  approved: boolean,
  specPath?: string,
  feedback?: string,
): string {
  if (approved) {
    return (
      `Spec approved by user${specPath ? ` at ${specPath}` : ''}.` +
      `${feedback ? ` Feedback: ${feedback}` : ''}` +
      ' The approved Implementation Plan is the basis for any requested implementation.'
    );
  }
  return (
    `Spec rejected by user.` +
    `${feedback ? ` Requested changes: ${feedback}` : ''}` +
    ' Address the feedback and resubmit through the same review control with a materially revised body.'
  );
}

export const SPEC_APPROVAL_REMINDER =
  '<system-reminder>Mode transition: Spec → Build. For a spec-only request, report the approved document. ' +
  'If implementation was requested, implement and verify the approved steps within the active permissions.</system-reminder>';
