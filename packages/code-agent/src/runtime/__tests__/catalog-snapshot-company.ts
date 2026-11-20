/**
 * Company contexts for the catalog snapshot (run-coder-catalog-snapshot):
 * what runCoder reads at setup, with a stub orchestrator. Setup only builds
 * tools and hooks (their handlers call the orchestrator later, never here),
 * so every method answers a neutral value: list… → [], has… and is… →
 * false, on… → an unsubscribe, the rest → undefined; listProjects names the one
 * fixture project and getSessionConfigJson is '{}' (no QA skill).
 *
 * - master: isMaster, role 'master', no agent run id. runCoder gives it no
 *   subagent deps; spawn_agent is still registered (fallback deps) because
 *   spawn_subordinate_agent exists.
 * - subordinate: role 'backend' (no QA tier), agent run id 'run-sub-1',
 *   runtimeKind 'company': subagent deps, so spawn_agent and its companions
 *   (and workflow under Ultra). A subordinate never registers task_list, so
 *   there is no execute_tasks variant.
 * - app-studio-subordinate: the same with runtimeKind 'app_studio': no
 *   subagent deps (allowFreeSubordinateSpawn unset), no request_review, no
 *   kanban: the variant without the old apparatus.
 */
import type { CompanyContext } from '@mcp/company/types.js';

export type CompanyKind = 'master' | 'subordinate' | 'app-studio-subordinate';

function stubOrchestrator(project: { projectId: number; projectRoot: string }): CompanyContext['orchestrator'] {
  const fixed: Record<string, unknown> = {
    listProjects: () => [{ id: project.projectId, name: 'fixture', rootPath: project.projectRoot, label: null }],
    getSessionConfigJson: () => '{}',
  };
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop in fixed) return fixed[prop];
      if (prop.startsWith('list')) return () => [];
      if (prop.startsWith('has') || prop.startsWith('is')) return () => false;
      if (prop.startsWith('on')) return () => () => undefined;
      return () => undefined;
    },
  }) as CompanyContext['orchestrator'];
}

export function companyContextFor(kind: CompanyKind, project: { projectId: number; projectRoot: string }): CompanyContext {
  const master = kind === 'master';
  return {
    orchestrator: stubOrchestrator(project),
    companySessionId: 'company-session-fixture',
    runtimeKind: kind === 'app-studio-subordinate' ? 'app_studio' : 'company',
    agentRole: master ? 'master' : 'backend',
    agentRunId: master ? null : 'run-sub-1',
    allowedProjectIds: [project.projectId],
    isMaster: master,
  };
}
