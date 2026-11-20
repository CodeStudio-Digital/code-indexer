/**
 * Role-recommendation core — the embedding-backed pipeline run shared by the
 * `/recommend-role` HTTP route AND the worker→main `recommend` shim
 * (CompanyScheduler). Factored out so the autonomous scheduler reuses the exact
 * same "brain" the dashboard button does, instead of a second divergent copy.
 *
 * Pure-ish: reads session state from the store, runs the role pipeline, returns
 * the ranked recommendations. No mutations, no HTTP coupling.
 */
import type { ServerDeps } from '../../deps.js';
import {
  createRolePipeline,
  recommendRoles,
  type IdleRunDescriptor,
  type RoleDescriptor,
} from '@mcp/company/role-pipeline/index.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import type { CompanySessionId } from '@mcp/session-storage';

interface RecommendRolesForSessionInput {
  companySessionId: CompanySessionId;
  taskText: string;
  k?: number;
}

interface RecommendRolesForSessionResult {
  recommendations: Array<{
    role: string;
    kind: string;
    agentRunId?: string;
    score: number;
    signals?: unknown;
  }>;
}

/** Subordinate statuses that consume capacity (mirror the route's set). */
const RUNNING_STATUSES = new Set<string>([
  'running', 'working',
  'waiting', 'waiting_plan', 'waiting_question', 'waiting_tasks',
  'reviewing', 'blocked',
]);

/**
 * Run the role pipeline for a session + task. Returns `{ recommendations: [] }`
 * when the session is gone or no roles are configured — callers treat an empty
 * list as "no recommendation".
 */
export async function recommendRolesForSession(
  deps: ServerDeps,
  input: RecommendRolesForSessionInput,
): Promise<RecommendRolesForSessionResult> {
  const {
    companyStore,
    sessionStore,
    recommendationEmbed,
    roleEmbeddingStore,
    pipelineTelemetrySink,
  } = deps;
  await sessionStore.ensureCatalog();
  let companyFiles: CompanySessionFiles;
  try {
    companyFiles = new CompanySessionFiles({
      companySessionId: input.companySessionId,
      sessionStore,
    });
  } catch {
    return { recommendations: [] };
  }
  const session = companyFiles.getSession();

  const template = session.template_id != null
    ? companyStore.getTemplate(session.template_id)
    : null;
  const availableRoles: RoleDescriptor[] = (template?.roles ?? []).map((r) => {
    const skillsArr = Array.isArray(r.skills) ? r.skills : [];
    const skillsText = skillsArr.join(', ');
    return {
      role: r.role,
      description: skillsText ? `${r.role}. Skills: ${skillsText}` : `${r.role} role`,
      skills: skillsArr,
      preferredModel: r.model || undefined,
    };
  });
  if (availableRoles.length === 0) return { recommendations: [] };

  const activeRuns = companyFiles.listAgentRunsSync();
  const runningByRole: Record<string, number> = {};
  const idleRuns: IdleRunDescriptor[] = [];
  for (const r of activeRuns) {
    if (RUNNING_STATUSES.has(r.status)) {
      runningByRole[r.role] = (runningByRole[r.role] ?? 0) + 1;
    } else if (r.status === 'idle') {
      idleRuns.push({ agentRunId: r.id, role: r.role });
    }
  }

  const pipeline = createRolePipeline({
    embed: recommendationEmbed,
    roleEmbeddingStore,
    telemetry: pipelineTelemetrySink,
  });
  const result = await recommendRoles(pipeline, {
    queryId: `recommend-role-${input.companySessionId}-${Date.now()}`,
    taskText: input.taskText,
    availableRoles,
    idleRuns,
    runningByRole,
    k: input.k,
  });
  return result as RecommendRolesForSessionResult;
}
