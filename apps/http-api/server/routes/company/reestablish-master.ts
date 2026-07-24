/**
 * POST /api/company/sessions/:id/reestablish-master
 *
 * Boots a NEW master for an existing company session, seeded with a deep
 * recovery briefing as its first user message. The new master:
 *
 *   1. Audits the kanban + board history
 *   2. Diagnoses and documents inconsistencies
 *   3. Repairs cards / goal / objectives
 *   4. Continues as the active master from that point (delegating,
 *      coordinating, finishing the work the previous master abandoned)
 *
 * Returns the NEW master coder_session_id so the dashboard can navigate
 * to the (single) master tab — the broken master's coder_session stays
 * in the DB as historical record.
 *
 * Architecture choices:
 *
 *   • Workers-only orchestration. The stale worker is fully evicted first;
 *     a fresh worker then rebuilds its runtime from the durable DB state.
 *
 *   • The recovery briefing is the FIRST USER MESSAGE, not a system
 *     prompt override. The master's normal system prompt (loaded via
 *     buildMasterCompanyBlock + base.txt) is preserved so the agent
 *     knows how to act as a master once recovery is done.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import {
  evictCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';
import {
  appOwnedControlPlaneConflict,
  isAppOwnedCompanySession,
} from './runtime-capabilities.js';

interface ReestablishBody {
  /** Optional override of the master's provider/model. */
  provider?: string;
  model?: string;
  /** Optional override of the max turn budget (default 100). */
  max_turns?: number;
}

/** Locate the master-recovery prompt relative to this compiled file. */
async function loadRecoveryBriefing(): Promise<string> {
  // The prompt ships under packages/code-agent/src/prompts. In dev (tsx)
  // and prod (dist) the relative layout is the same: prompts live a
  // few directories up from the compiled route. Try the dev path first;
  // fall back to the dist path if needed.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../../../packages/code-agent/src/prompts/master-recovery.txt'),
    resolve(here, '../../../../../dist/packages/code-agent/src/prompts/master-recovery.txt'),
    resolve(here, '../../../../packages/code-agent/src/prompts/master-recovery.txt'),
  ];
  let lastError: unknown;
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf8');
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `Could not locate master-recovery.txt; tried ${candidates.join(', ')}. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export function mountReestablishMasterRoute(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

  app.post('/api/company/sessions/:id/reestablish-master', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    if (isAppOwnedCompanySession(companyStore, id)) {
      return appOwnedControlPlaneConflict(c, 'Master rotation/recovery');
    }

    const body = (await parseJsonBody<ReestablishBody>(c)) ?? {};

    // Resolve provider/model — default to whatever the session config says.
    let cfg: {
      master_provider?: string;
      master_model?: string;
      role_assignments?: RoleConfig[];
    } = {};
    try {
      cfg = session.config_json ? JSON.parse(session.config_json) : {};
    } catch {
      /* malformed — fall through to validation below */
    }
    const provider = body.provider ?? cfg.master_provider;
    const model = body.model ?? cfg.master_model;
    if (!provider || !model) {
      return c.json(
        {
          error: 'no_master_provider',
          detail:
            'Could not resolve master provider/model from session config. Pass `provider` and `model` in the request body.',
        },
        400,
      );
    }
    const roleConfigs = Array.isArray(cfg.role_assignments) ? cfg.role_assignments : [];

    // Load the deep recovery briefing — used as the new master's first
    // user message. NOT a system prompt override (the master's normal
    // system prompt stays intact so it knows how to act as a master
    // once recovery is done in Phase 4).
    let recoveryBriefing: string;
    try {
      recoveryBriefing = await loadRecoveryBriefing();
    } catch (e) {
      return c.json(
        {
          error: 'prompt_load_failed',
          detail: e instanceof Error ? e.message : String(e),
        },
        500,
      );
    }

    // Recovery means we want a fresh worker (briefing + new master
    // coder_session_id). Evict any stale entry first; the next
    // getOrSpawn spins up a new worker_thread. The previous master's
    // coder_session row stays in DB as history — kanban + board state
    // are loaded via the orchestrator's services which talk to the same
    // SQLite file.
    await evictCompanyOrchestrator(id);

    const { orchestrator } = await getOrSpawnCompanyOrchestrator(id);

    // Start the new master. This creates a NEW master coder_session_id
    // and a NEW company_agent_run with role='master'. The runner begins
    // processing the recovery briefing as its first user message.
    let handle;
    try {
      handle = await orchestrator.startMaster({
        userMessage: recoveryBriefing,
        provider,
        model,
        maxTurns: body.max_turns ?? 100,
        roleConfigs,
      });
    } catch (e) {
      const outcomeUnknown = isMutationOutcomeUnknownError(e);
      await evictCompanyOrchestrator(id);
      return c.json(
        outcomeUnknown
          ? {
              error: 'outcome_unknown',
              code: 'OUTCOME_UNKNOWN',
              detail:
                'The recovery master may have started before its acknowledgement was lost; ' +
                'the start RPC was not replayed.',
            }
          : {
              error: 'master_start_failed',
              detail: e instanceof Error ? e.message : String(e),
            },
        500,
      );
    }

    return c.json({
      ok: true,
      master_coder_session_id: handle.masterSessionId,
      company_session_id: id,
      provider,
      model,
    });
  });
}
