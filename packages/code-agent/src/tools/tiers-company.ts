/**
 * Functional tool catalogs whose availability depends on the current runtime.
 *
 * These sets deliberately do NOT map to `bootstrap`. Each family owns a
 * dedicated tier which runCoder auto-activates only when the matching runtime
 * capability is present. This keeps the global bootstrap catalog about the
 * coding agent itself instead of making it a grab-bag of every product surface.
 */

/** Collaboration shared by Company masters and subordinates. */
export const COMPANY_TOOLS: ReadonlySet<string> = new Set([
  // Master-directed interaction (subordinate-only registration).
  'ask_master',
  'submit_plan_to_master',
  'submit_tasks_to_master',
  'submit_specification_to_master',
  'send_to_agent',
  'send_to_master',
  'respond_to_inbox',
  'read_my_inbox',
  'check_inbox_answer',
  // Shared board + subordinate Kanban surface.
  'post_to_board',
  'read_board',
  'set_agent_status',
  'kanban_read_my_card',
  'kanban_post_comment',
  'kanban_update_objectives',
  'kanban_move_to_review',
  // Shared drive — persistent file pool across the company template.
  'read_shared_file',
  'write_shared_file',
  'append_shared_file',
  'delete_shared_file',
  'list_shared_files',
  // Cross-agent comms (code-agent tools, registered only in Company runs).
  'send_message',
  'send_input',
  'list_agents',
  'wait_agents',
  'followup_task',
  // Session-shared env vars (DB-backed; no sandbox required).
  'env_list',
  'env_read',
  'env_set',
  'env_delete',
  'env_validate',
  // Durable company knowledge is available independently of containers.
  'docs_delete',
  'docs_index_update',
  'docs_list',
  'docs_search',
  'docs_read',
  'docs_write',
]);

/** Generic QA workflow, auto-active for QA/qa-playwright roles. */
export const QA_TOOLS: ReadonlySet<string> = new Set([
  'qa_get_browser_endpoint',
  'qa_publish_result',
  'qa_start_run',
  'qa_check_preview',
]);

/**
 * Sandbox-bound builder tools. Pipeline orchestration is master-owned and
 * therefore lives in MASTER_TOOLS; this set contains only surfaces backed by
 * the subordinate/master sandbox binding.
 */
export const SANDBOX_TOOLS: ReadonlySet<string> = new Set([
  // Sandbox/service inspection and lifecycle.
  'read_sandbox_logs',
  'list_services',
  'service_logs',
  'service_restart',
  'service_start',
  'service_stop',
]);
