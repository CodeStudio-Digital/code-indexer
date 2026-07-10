/**
 * Tier catalog for company- and builder-mode tools.
 *
 * Split out of tiers.ts (which owns the core tiering logic) so the core file
 * stays focused: these two sets are pure DATA enumerating tools that live in
 * the @mcp/company package and are registered ONLY in their respective session
 * classes. They exist so `getToolTier` has an explicit entry for every tool —
 * closing the "silent bootstrap fallback" gotcha (a registered-but-untiered
 * tool used to ship on turn 1 of every session). `getToolTier` maps both sets
 * to `bootstrap` to preserve exact historical behavior; a future change could
 * give them their own non-auto-promoted tier if company/builder sessions adopt
 * progressive disclosure too.
 */

/**
 * Company tools — registered only in company sessions (master/subordinate),
 * gated by `opts.companyContext` in index.ts. Always-on within those sessions.
 */
export const COMPANY_TOOLS: ReadonlySet<string> = new Set([
  // Shared drive — persistent file pool across the company template.
  'read_shared_file',
  'write_shared_file',
  'append_shared_file',
  'delete_shared_file',
  'list_shared_files',
  // Cross-agent comms (code-agent tools, registered in the company block).
  'send_message',
  'send_input',
  'list_agents',
  'wait_agents',
  'followup_task',
  // Cross-agent comms / inbox (@mcp/company).
  'send_to_agent',
  'send_to_master',
  'read_my_inbox',
  'check_inbox_answer',
  // Subordinate spec escalation.
  'submit_specification_to_master',
  // QA (subordinate, gated by the qa-playwright skill's allowed-tools).
  'qa_get_browser_endpoint',
  'qa_publish_result',
  'qa_start_run',
  // Session-shared env vars (DB-backed). Registered for EVERY company session
  // in index.ts (not only builder ones) — master read-only via master-filter,
  // subordinates read+write. Backed by `company_session_envs`, no container.
  'env_list',
  'env_read',
  'env_set',
  'env_delete',
  'env_validate',
]);

/**
 * Sandbox-bound tools — registered only when the session carries a live
 * sandbox binding (index.ts `if (companyContext?.sandbox)`), i.e.
 * service-bound company subordinates. Always-on within those sessions.
 */
export const BUILDER_TOOLS: ReadonlySet<string> = new Set([
  // db_list/db_query/db_schema moved to the core `db` tier (tiers.ts
  // DB_TOOLS) — the v2 db_* tools are registered for EVERY session and
  // unlocked via expand_toolset('db'), not gated to sandbox sessions.
  // In-container docs (<workdir>/docs/).
  'docs_delete',
  'docs_index_update',
  'docs_list',
  'docs_read',
  'docs_write',
  // NOTE: env_* tools moved to COMPANY_TOOLS — they're registered for every
  // company session (external-backend sessions need them too), not only when
  // a sandbox binding is present.
  // Sandbox + pipeline/service control.
  'read_sandbox_logs',
  'get_pipeline_status',
  'list_pipelines',
  'list_services',
  'start_pipeline',
  'stop_pipeline',
  // service_* (B5) — registered under the same sandbox-binding gate as
  // list_services; in-handler authorization decides who may control what.
  'service_logs',
  'service_restart',
  'service_start',
  'service_stop',
]);

/**
 * App Studio tools are registered only for `builder_json.kind === 'app'`.
 * Keeping the catalog explicit prevents them from riding the unknown-tool
 * bootstrap fallback and lets cap-priority tests reason about the executor.
 */
export const APP_STUDIO_TOOLS: ReadonlySet<string> = new Set([
  'app_get_context',
  'app_get_pipeline',
  'app_get_spec',
  'app_get_spec_history',
  'app_save_spec',
  'app_propose_spec_revision',
  'app_spec_audit',
  'app_get_architecture',
  'app_save_architecture',
  'app_architecture_audit',
  'app_search_architecture_docs',
  'app_fetch_architecture_doc',
  'app_run_test_cycle',
  'app_save_db_migration',
  'app_submit_stage',
  'app_record_feature',
  'app_list_features',
  'app_provision_db',
]);
