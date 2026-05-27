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
  specPath: string,
  feedback?: string,
): string {
  if (approved) {
    return (
      `Spec approved by user at ${specPath}.` +
      `${feedback ? ` Feedback: ${feedback}` : ''}` +
      ` You may now proceed with mutating tools — derive tasks from the spec's Implementation Plan via submit_tasks before editing.`
    );
  }
  return (
    `Spec rejected by user.` +
    `${feedback ? ` Requested changes: ${feedback}` : ''}` +
    ` Revise the spec body to address the feedback and call submit_spec again. Cosmetic resubmits with identical hash are refused.`
  );
}
