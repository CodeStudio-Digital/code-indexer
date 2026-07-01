/**
 * ensureCompanyMasterLive — bring a company session's master back to life when
 * its orchestrator is no longer in the pool.
 *
 * Company orchestrators live ONLY in memory in the backend process, so they
 * vanish on idle-TTL eviction OR a process/dev restart. The human-interaction
 * routes (`/answer`, `/message`, `/plan-response`) used to 404 with
 * "No active orchestrator" in that window. This helper re-spawns the worker and
 * RESUMES the master from its persisted `coder_session_id` (full history + board
 * survive), delivering `message` as a continuation. runCoder seals any dangling
 * `ask_user`/`submit_plan` tool_use on resume (runner.ts "Safety net 2"), so
 * delivering the answer as a follow-up message is safe.
 *
 * Mirrors the spawn-and-resume core of `POST /resume` (incl. the one-shot
 * `port_closed` retry) but returns the orchestrator instead of an SSE stream, so
 * the JSON interaction routes can reuse it. Serialized via `withSessionLock` so
 * two concurrent interactions can't each spawn a master.
 */
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { isPortClosedError } from '@mcp/orchestrator-host';
import type { ServerDeps } from '../../deps.js';
import {
  getCompanyOrchestrator,
  deleteCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { withSessionLock } from '../coder/sessionLock.js';
import { resolveAndRunMaster } from './master-resolve.js';

const PORT_CLOSED_RETRY_DELAY_MS = 600;

export interface EnsureMasterOpts {
  /** Delivered to the master as a continuation (the answer / message / plan verdict). */
  message: string;
  attachments?: Parameters<CompanyOrchestrator['startMaster']>[0]['attachments'];
  thinking?: boolean;
}

export type EnsureMasterResult =
  | { orchestrator: CompanyOrchestrator; resumed: boolean }
  | { error: string; status: 400 | 404 | 500 };

export async function ensureCompanyMasterLive(
  id: number,
  deps: Pick<ServerDeps, 'companyStore'>,
  opts: EnsureMasterOpts,
): Promise<EnsureMasterResult> {
  const { companyStore } = deps;

  return withSessionLock(id, async (): Promise<EnsureMasterResult> => {
    const existing = getCompanyOrchestrator(id);
    if (existing) return { orchestrator: existing, resumed: false };

    const session = companyStore.getCompanySession(id);
    if (!session) return { error: 'Not found', status: 404 };

    let config: {
      master_provider?: string;
      master_model?: string;
      master_reasoning_effort?: string;
      role_assignments?: Parameters<CompanyOrchestrator['startMaster']>[0]['roleConfigs'];
    } = {};
    try { config = JSON.parse(session.config_json); } catch { /* defaults below */ }
    const roleConfigs = config.role_assignments ?? [];

    // A session that has a master run RESUMES it (reuses coder_session_id);
    // a brand-new sub-session with no master run cold-starts.
    const masterRun = companyStore.listAgentRuns(id).filter((r) => r.role === 'master').pop();

    const attemptSpawnAndResume = async (): Promise<CompanyOrchestrator> => {
      const { orchestrator } = await getOrSpawnCompanyOrchestrator(id);
      void orchestrator.pipelineRecoverRunning().catch((err) => {
        console.warn(`[company s=${id}] pipeline recovery failed:`, err);
      });
      await resolveAndRunMaster(orchestrator, !!masterRun, {
        userMessage: opts.message,
        provider: config.master_provider ?? 'anthropic',
        model: config.master_model ?? 'claude-sonnet-4-6',
        maxTurns: 100,
        roleConfigs,
        attachments: opts.attachments,
        thinking: opts.thinking,
        reasoningEffort: config.master_reasoning_effort,
      });
      return orchestrator;
    };

    try {
      return { orchestrator: await attemptSpawnAndResume(), resumed: true };
    } catch (err) {
      // `port_closed`: the worker exited mid-RPC while WorkerHost was already
      // restarting it. Evict the dead handle and retry ONCE with a fresh spawn.
      if (isPortClosedError(err)) {
        console.warn(`[company s=${id}] ensureMasterLive hit port_closed; evict + retry once.`);
        deleteCompanyOrchestrator(id);
        await new Promise((r) => setTimeout(r, PORT_CLOSED_RETRY_DELAY_MS));
        try {
          return { orchestrator: await attemptSpawnAndResume(), resumed: true };
        } catch (err2) {
          deleteCompanyOrchestrator(id);
          return { error: `Resume failed after retry: ${err2 instanceof Error ? err2.message : String(err2)}`, status: 500 };
        }
      }
      return { error: `Resume failed: ${err instanceof Error ? err.message : String(err)}`, status: 500 };
    }
  });
}
