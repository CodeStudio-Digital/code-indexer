import type {
  CoderTool,
  ToolExecutionClass,
  ToolRepeatPolicy,
  ToolRiskLevel,
} from '@mcp/code-agent/core/tool.js';

/**
 * Company tools are assembled from many small factories. Historically most of
 * them omitted execution metadata, so the code-agent fallback classified
 * state-changing operations as stable, parallel-safe reads. Normalize the
 * runtime catalog at the package boundary while preserving every explicit
 * declaration made by an individual tool.
 */

const READ_ONLY_NAMES = new Set([
  'check_inbox_answer',
  'db_list',
  'db_query',
  'db_schema',
  'docs_list',
  'docs_read',
  'env_list',
  'env_read',
  'env_validate',
  'kanban_get_card',
  'kanban_list_cards',
  'kanban_read_my_card',
  'list_company_projects',
  'list_containers',
  'list_services',
  'list_shared_files',
  'list_subordinates',
  'read_board',
  'read_container_logs',
  'read_sandbox_logs',
  'read_shared_file',
  'recommend_role',
  'service_logs',
]);

const READ_ONLY_PREFIXES = [
  'get_',
  'list_',
  'read_',
  'ds_analyze_',
  'ds_audit_',
  'ds_component',
  'ds_docs',
  'ds_get_',
  'ds_list_',
  'qa_get_',
] as const;

const CONTROL_NAMES = new Set([
  'abort_subordinate_agent',
  'answer_subordinate_question',
  'ask_master',
  'approve_subordinate_plan',
  'approve_subordinate_plans',
  'approve_subordinate_tasks',
  'broadcast_to_roles',
  'finalize_subordinates',
  'forward_to_agent',
  'post_to_board',
  'respond_to_inbox',
  'resume_subordinate',
  'send_to_agent',
  'send_to_master',
  'set_agent_status',
  'spawn_subordinate_agent',
  'submit_plan_to_master',
  'submit_specification_to_master',
  'submit_tasks_to_master',
]);

// These writes belong to the Company board. They keep their normal mutation,
// approval and scheduling policies, but do not acquire the project file lock.
const KANBAN_WRITES = new Set([
  'kanban_create_card', 'kanban_move_card', 'kanban_move_to_review',
  'kanban_update_meta', 'kanban_update_objectives', 'kanban_post_comment',
  'kanban_add_dependency', 'kanban_remove_dependency', 'kanban_assign_agent', 'kanban_plan_graph',
]);

const EXECUTE_PREFIXES = ['qa_', 'service_'] as const;
const EXECUTE_NAMES = new Set([
  'review_subordinate_work',
]);
const ADMIN_VERBS = /(?:^|_)(delete|destroy|drop|publish|deploy|remove|stop)(?:_|$)/i;

function startsWithAny(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

function isReadOnly(name: string): boolean {
  return READ_ONLY_NAMES.has(name)
    || startsWithAny(name, READ_ONLY_PREFIXES)
    || name.endsWith('_audit');
}

function isControl(name: string): boolean {
  return CONTROL_NAMES.has(name);
}

function inferredMetadata(name: string): {
  mutates: boolean;
  parallelSafe: boolean;
  riskLevel: ToolRiskLevel;
  repeatPolicy: ToolRepeatPolicy;
  executionClass: ToolExecutionClass;
} {
  if (isReadOnly(name)) {
    return {
      mutates: false,
      parallelSafe: true,
      riskLevel: 'read',
      // Company reads observe live DB/container state and must never be reused
      // solely because their arguments match an earlier call.
      repeatPolicy: 'volatile',
      executionClass: 'read',
    };
  }

  if (isControl(name)) {
    return {
      // Coordination changes internal orchestration state, but must remain
      // callable while a subordinate is waiting behind a plan/spec gate.
      mutates: false,
      parallelSafe: false,
      riskLevel: 'read',
      repeatPolicy: 'volatile',
      executionClass: 'control',
    };
  }

  const execute = EXECUTE_NAMES.has(name) || startsWithAny(name, EXECUTE_PREFIXES);
  return {
    mutates: true,
    parallelSafe: false,
    riskLevel: ADMIN_VERBS.test(name) ? 'admin' : execute ? 'execute' : 'write',
    repeatPolicy: 'mutating',
    executionClass: execute ? 'execute' : 'write',
  };
}

export function withCompanyToolMetadata(tool: CoderTool): CoderTool {
  const inferred = inferredMetadata(tool.name);
  const mutates = tool.mutates ?? inferred.mutates;
  return {
    ...tool,
    ...(tool.source === 'native' && !tool.effectBoundary && (isControl(tool.name) || KANBAN_WRITES.has(tool.name))
      ? { effectBoundary: 'control' as const } : {}),
    mutates,
    parallelSafe: tool.parallelSafe ?? (mutates ? false : inferred.parallelSafe),
    riskLevel: tool.riskLevel ?? inferred.riskLevel,
    repeatPolicy: tool.repeatPolicy ?? (tool.repeatable ? 'pollable' : inferred.repeatPolicy),
    executionClass: tool.executionClass ?? inferred.executionClass,
  };
}

export function withCompanyToolsMetadata(tools: readonly CoderTool[]): CoderTool[] {
  return tools.map(withCompanyToolMetadata);
}
