import type { AgentId } from './index.js';

export const APP_SPECIALIST_AGENT_IDS = ['app_spec', 'app_db', 'app_architect'] as const;

export type AppSpecialistAgentId = (typeof APP_SPECIALIST_AGENT_IDS)[number];

const APP_SPECIALIST_AGENT_SET = new Set<AgentId>(APP_SPECIALIST_AGENT_IDS);

export function isAppSpecialistAgentId(value: unknown): value is AppSpecialistAgentId {
  return typeof value === 'string' && APP_SPECIALIST_AGENT_SET.has(value as AgentId);
}

const COMMON_READ_TOOLS = [
  'ask_user',
  'app_get_context',
  'app_get_pipeline',
  'app_get_spec',
  'app_get_spec_history',
] as const;

export const APP_SPECIALIST_TOOL_ALLOWLISTS: Record<AppSpecialistAgentId, ReadonlySet<string>> = {
  app_spec: new Set([
    ...COMMON_READ_TOOLS,
    'app_spec_audit',
    'app_save_spec',
    'app_propose_spec_revision',
    'app_submit_stage',
  ]),
  app_db: new Set([
    ...COMMON_READ_TOOLS,
    'app_get_architecture',
    'app_spec_audit',
    'app_save_spec',
    'app_propose_spec_revision',
    'app_save_db_migration',
    'app_provision_db',
    'app_submit_stage',
    'db_list',
    'db_schema',
    'db_query',
    'db_command',
  ]),
  app_architect: new Set([
    ...COMMON_READ_TOOLS,
    'app_spec_audit',
    'app_save_spec',
    'app_propose_spec_revision',
    'app_get_architecture',
    'app_save_architecture',
    'app_architecture_audit',
    'app_search_architecture_docs',
    'app_fetch_architecture_doc',
    'app_submit_stage',
  ]),
};

export const APP_SPECIALIST_PRESERVE_OUTPUT_TOOLS = new Set(
  Object.values(APP_SPECIALIST_TOOL_ALLOWLISTS).flatMap((tools) => [...tools]),
);
