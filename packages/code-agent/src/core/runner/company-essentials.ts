/**
 * Tools that must NEVER be dropped by the `maxTools` truncation in
 * `buildTools`. Company sessions register ~80–150 tools (board, kanban,
 * shared drive, master/sub orchestration, DS, MCP per project) and on
 * busy sessions can exceed a model's max-tools cap. Without this set
 * the truncation slices alphabetically from the tail, taking out the
 * `s`-prefix orchestration (`spawn_subordinate_agent`, `submit_*`,
 * `set_agent_status`) and leaving the master narrating "I can't
 * delegate" in a loop — the exact bug reported by the user.
 *
 * The list is short on purpose: only the tools an agent absolutely
 * cannot function without. Discoverable / nice-to-have tools fall in
 * the truncation bucket and can be re-enumerated via `find_tools` or
 * `expand_toolset` later.
 *
 * Master essentials cover delegation primitives (spawn / forward /
 * resume / list_subordinates / wait / abort / approve / answer / finalize),
 * the inbox response, and the board read/write surface.
 *
 * Subordinate essentials cover the escalation primitives back to the
 * master (`ask_master`, `submit_plan_to_master`, `submit_tasks_to_master`)
 * plus the board read/write surface (so subs can post + scan).
 */
export function isEssentialCompanyTool(name: string, isMaster: boolean): boolean {
  // Shared across master + subordinate: the board is the canonical
  // communication channel; without it the agent has no way to talk
  // to siblings.
  if (
    name === 'post_to_board' ||
    name === 'read_board' ||
    name === 'set_agent_status'
  ) {
    return true;
  }
  if (isMaster) {
    return (
      name === 'spawn_subordinate_agent' ||
      name === 'forward_to_agent' ||
      name === 'resume_subordinate' ||
      name === 'list_subordinates' ||
      name === 'list_company_projects' ||
      name === 'wait_for_subordinates' ||
      name === 'abort_subordinate_agent' ||
      name === 'finalize_subordinates' ||
      name === 'approve_subordinate_plan' ||
      name === 'approve_subordinate_tasks' ||
      name === 'answer_subordinate_question' ||
      name === 'respond_to_inbox'
    );
  }
  // Subordinate path
  return (
    name === 'ask_master' ||
    name === 'submit_plan_to_master' ||
    name === 'submit_tasks_to_master'
  );
}
