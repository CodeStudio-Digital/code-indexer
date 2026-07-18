import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { appStudioSessionBinding, type AppToolBinding } from './binding.js';
import {
  appDispatchReadyWork,
  appGetDbState,
  appGetPlan,
  appGetState,
  appRecordWorkEvidence,
  appRequestDecision,
  appRequestPlanApproval,
  appRunChecks,
  appUpdateDatabase,
  appUpdatePlan,
  appUpsertWorkItems,
} from './app-workflow.js';

export { setAppStudioStore, getAppStudioStore } from './store-binding.js';
export { ensureAppStudioDbConnection, getAppStudioDbClientStore, setAppStudioDbClientStore } from './db-client-bridge.js';
export { appStudioSessionBinding } from './binding.js';
export type { AppToolBinding } from './binding.js';

export type AppStudioToolAudience = 'company-master' | 'company-subordinate';
export interface BuildAppStudioToolsOptions {
  audience: AppStudioToolAudience;
  appSessionId: number;
  role?: string;
}

const SUBORDINATE_READ = new Set(['app_get_state', 'app_get_plan', 'app_get_db_state']);
const ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  research: ['app_request_decision', 'app_run_checks'],
  architect: ['app_update_plan', 'app_upsert_work_items', 'app_request_decision', 'app_request_plan_approval', 'app_run_checks'],
  database: ['app_update_database', 'app_run_checks', 'app_record_work_evidence'],
  backend: ['app_update_database', 'app_run_checks', 'app_record_work_evidence'],
  frontend: ['app_run_checks', 'app_record_work_evidence'],
  fullstack: ['app_update_database', 'app_run_checks', 'app_record_work_evidence'],
  ux: ['app_run_checks', 'app_record_work_evidence'],
  qa: ['app_run_checks', 'app_record_work_evidence', 'app_request_decision'],
};

export const APP_STUDIO_TOOL_NAMES: readonly string[] = [
  'app_get_state',
  'app_get_plan',
  'app_update_plan',
  'app_upsert_work_items',
  'app_request_decision',
  'app_request_plan_approval',
  'app_dispatch_ready_work',
  'app_record_work_evidence',
  'app_get_db_state',
  'app_update_database',
  'app_run_checks',
];

export function appStudioToolNamesForRole(audience: AppStudioToolAudience, role?: string): ReadonlySet<string> {
  if (audience === 'company-master') return new Set(APP_STUDIO_TOOL_NAMES);
  return new Set([...SUBORDINATE_READ, ...(ROLE_TOOLS[role?.trim().toLowerCase() ?? ''] ?? [])]);
}

function allTools(binding: AppToolBinding): CoderTool[] {
  return [
    appGetState(binding),
    appGetPlan(binding),
    appUpdatePlan(binding),
    appUpsertWorkItems(binding),
    appRequestDecision(binding),
    appRequestPlanApproval(binding),
    appDispatchReadyWork(binding),
    appRecordWorkEvidence(binding),
    appGetDbState(binding),
    appUpdateDatabase(binding),
    appRunChecks(binding),
  ];
}

export function buildAppStudioTools(_projectId: number, options: BuildAppStudioToolsOptions): CoderTool[] {
  if (!Number.isInteger(options.appSessionId) || options.appSessionId <= 0) {
    throw new Error('Persistent App Company tools require a positive appSessionId.');
  }
  const tools = allTools(appStudioSessionBinding(options.appSessionId));
  const allowed = appStudioToolNamesForRole(options.audience, options.role);
  return tools.filter((tool) => allowed.has(tool.name));
}
