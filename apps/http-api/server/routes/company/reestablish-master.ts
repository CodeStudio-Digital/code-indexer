/**
 * POST /api/company/sessions/:id/reestablish-master
 *
 * Spawns a one-shot recovery agent that audits the kanban board and
 * master session state, repairs inconsistencies (missing cards, stuck
 * columns, unset goal), and writes a final summary report. The agent
 * is tagged with role `_master_recovery` and runs with the prompt at
 * `packages/code-agent/src/prompts/master-recovery.txt`.
 *
 * Returns the new coder_session_id so the dashboard can navigate to it.
 *
 * Prerequisites:
 *   - The company orchestrator must be alive in the registry. If the
 *     session was fully stopped, the operator must start it first
 *     (POST /api/company/sessions/:id/start) before calling this.
 *   - The session must have at least one linked project — the recovery
 *     agent runs scoped to one of them (the first by default; override
 *     via `project_id` in the request body).
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { orchestratorRegistry } from '../../../sse/OrchestratorRegistry.js';
import { loadPrompt } from '@mcp/code-agent/prompts/loader.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';

interface ReestablishBody {
  /** Optional override — defaults to first linked project_id. */
  project_id?: number;
  /** Optional custom task — defaults to the standard recovery briefing. */
  task?: string;
  /** Provider override. Defaults to the master's own provider/model. */
  provider?: string;
  model?: string;
}

const RECOVERY_ROLE = '_master_recovery';

const DEFAULT_TASK =
  'Audit this company session\'s kanban board, identify inconsistencies (missing cards, stuck columns, unset goal, unchecked objectives), and repair them. Follow your system prompt strictly: ONE read_board, ONE kanban_list_cards, then targeted repairs, then a final markdown report. Do NOT poll list_subordinates, do NOT spawn subordinates, do NOT exceed 30 turns. Stop after the final report.';

export function mountReestablishMasterRoute(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.post('/api/company/sessions/:id/reestablish-master', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    const orchestrator = orchestratorRegistry.get(id);
    if (!orchestrator) {
      return c.json(
        {
          error: 'orchestrator_idle',
          detail:
            'The company session orchestrator is not running. Start it via POST /api/company/sessions/:id/start before calling reestablish-master.',
        },
        409,
      );
    }

    const body = (await parseJsonBody<ReestablishBody>(c)) ?? {};

    // Determine target project — caller can override; otherwise pick the
    // first linked project. Recovery is scoped to a single project so the
    // sandbox / file-tool surface is bounded.
    const linkedProjects = companyStore.listCompanySessionProjects(id);
    if (linkedProjects.length === 0) {
      return c.json(
        { error: 'no_projects', detail: 'Cannot spawn recovery: session has no linked projects.' },
        400,
      );
    }
    const projectId = body.project_id ?? linkedProjects[0].project_id;
    if (!linkedProjects.some((p) => p.project_id === projectId)) {
      return c.json(
        { error: 'project_not_linked', detail: `project_id=${projectId} is not linked to this session.` },
        400,
      );
    }

    // Resolve provider/model — default to the master's own (read from
    // session config_json). The recovery agent reuses the same model so
    // pricing/latency match what the operator is already paying for.
    let masterProvider = body.provider;
    let masterModel = body.model;
    if (!masterProvider || !masterModel) {
      try {
        const cfg = session.config_json ? JSON.parse(session.config_json) : {};
        masterProvider = masterProvider ?? cfg.master_provider;
        masterModel = masterModel ?? cfg.master_model;
      } catch {
        /* malformed config_json — fall through to error below */
      }
    }
    if (!masterProvider || !masterModel) {
      return c.json(
        {
          error: 'no_master_provider',
          detail:
            'Could not resolve master provider/model from session config. Pass `provider` and `model` in the request body.',
        },
        400,
      );
    }

    // Load the recovery prompt from disk (cached after first load). The
    // file is shipped with the package; loader handles the path resolution.
    let systemPromptOverride: string;
    try {
      systemPromptOverride = loadPrompt('master-recovery');
    } catch (e) {
      return c.json(
        {
          error: 'prompt_load_failed',
          detail: `Could not load master-recovery prompt: ${e instanceof Error ? e.message : String(e)}`,
        },
        500,
      );
    }

    // Inject (or replace) the `_master_recovery` role into the orchestrator's
    // live role configs. We read existing roles from session.config_json (the
    // source of truth) and merge in the recovery role, then push the full
    // list via updateRoleConfigs. Replacing vs. merging matters: a partial
    // pass would wipe the other template roles from the live roster.
    let existingRoles: RoleConfig[] = [];
    try {
      const cfg = session.config_json ? JSON.parse(session.config_json) : {};
      if (Array.isArray(cfg.role_assignments)) {
        existingRoles = cfg.role_assignments as RoleConfig[];
      }
    } catch {
      /* malformed — start with empty list; the recovery role still spawns */
    }
    const filtered = existingRoles.filter((r) => r.role !== RECOVERY_ROLE);
    const recoveryConfig: RoleConfig = {
      role: RECOVERY_ROLE,
      provider: masterProvider,
      model: masterModel,
      tier: 'full',
      projectIds: [projectId],
      systemPromptOverride,
      temperature: 0.3,
    };
    orchestrator.updateRoleConfigs([...filtered, recoveryConfig]);

    // Spawn — orchestrator handles coder_session + agent_run creation,
    // companyContext wiring, kanban tool availability.
    try {
      const result = await orchestrator.spawnSubordinate({
        role: RECOVERY_ROLE,
        task: body.task ?? DEFAULT_TASK,
        projectId,
        provider: masterProvider,
        model: masterModel,
        tier: 'full',
        wait: false,
        roleOverride: systemPromptOverride,
        temperature: 0.3,
      });
      return c.json({
        ok: true,
        agent_run_id: result.agentRunId,
        coder_session_id: result.coderSessionId,
        status: result.status,
        role: RECOVERY_ROLE,
      });
    } catch (e) {
      return c.json(
        {
          error: 'spawn_failed',
          detail: e instanceof Error ? e.message : String(e),
        },
        500,
      );
    }
  });
}
