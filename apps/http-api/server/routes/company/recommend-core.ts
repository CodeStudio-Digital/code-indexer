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
import { sessionRoles } from './session-role-roster.js';
import type { CompanySessionId } from '@mcp/session-storage';

interface RecommendRolesForSessionInput {
  companySessionId: CompanySessionId;
  taskText: string;
  k?: number;
  projectId?: number | null;
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

  const roster = sessionRoles(deps,session);
  const eligible = roster.filter(r => r.enabled !== false && r.role !== 'master' && (!input.projectId || !r.projectIds?.length || r.projectIds.includes(input.projectId)));
  const availableRoles: RoleDescriptor[] = eligible.map((r) => {
    const skillsArr = Array.isArray(r.skills) ? r.skills : [];
    const skillsText = skillsArr.join(', ');
    return {
      role: r.role,
      description: [r.role, r.systemPromptOverride, skillsText].filter(Boolean).join('. '),
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
    } else if (r.status === 'idle' && eligible.some(role => role.role === r.role)) {
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
