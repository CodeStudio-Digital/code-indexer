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
 * Mirrors the spawn-and-resume core of `POST /resume` but returns the
 * orchestrator instead of an SSE stream, so the JSON interaction routes can
 * reuse it. A lost RPC acknowledgement is never replayed automatically: the
 * original worker may already have applied the message. Serialized via
 * `withSessionLock` so two concurrent interactions can't each spawn a master.
 */
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { WorkerBackedOrchestrator } from '../../../sse/companyOrchestrator.js';
import { isMutationOutcomeUnknownError } from '@mcp/orchestrator-host';
import type { ServerDeps } from '../../deps.js';
import {
  getCompanyOrchestrator,
  evictCompanyOrchestrator,
  getOrSpawnCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { withSessionLock } from '../coder/sessionLock.js';
import { resolveAndRunMaster } from './master-resolve.js';
import { resolveEffectiveMasterRuntime } from '@mcp/company/services/subordinate/role-runtime.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import type { CompanySessionId } from '@mcp/session-storage';

interface EnsureMasterOpts {
  /** Delivered to the master as a continuation (the answer / message / plan verdict). */
  message: string;
  attachments?: Parameters<CompanyOrchestrator['startMaster']>[0]['attachments'];
  interject?: boolean;
  thinking?: boolean;
}

type EnsureMasterResult =
  | { orchestrator: WorkerBackedOrchestrator; resumed: boolean }
  | {
      error: string;
      status: 400 | 404 | 409 | 500 | 503;
      code?:
        | 'OUTCOME_UNKNOWN'
        | 'MASTER_RESUME_FAILED'
        | 'INTERACTION_PENDING'
        | 'MASTER_MESSAGE_NOT_ACCEPTED';
    };

export async function ensureCompanyMasterLive(
  id: CompanySessionId,
  deps: Pick<ServerDeps, 'sessionStore'>,
  opts: EnsureMasterOpts,
): Promise<EnsureMasterResult> {
  return withSessionLock(id, () => ensureCompanyMasterLiveLocked(id, deps, opts));
}

/**
 * Lock-free core for routes that need one critical section spanning their
 * durable prompt claim, worker delivery, and prompt resolution.
 *
 * The caller MUST already own this session's `withSessionLock`. Calling the
 * public wrapper from inside that lock would deadlock because the lock is not
 * re-entrant.
 */
export async function ensureCompanyMasterLiveLocked(
  id: CompanySessionId,
  deps: Pick<ServerDeps, 'sessionStore'>,
  opts: EnsureMasterOpts,
): Promise<EnsureMasterResult> {
  const existing = getCompanyOrchestrator(id);
  if (existing) {
    try {
      const delivery = await existing.sendMessageToMaster(opts.message, {
        interject: opts.interject,
        attachments: opts.attachments,
        thinking: opts.thinking,
      });
      if (!delivery.ok) {
        const interactionPending = delivery.pending === 'interactive_wait';
        return {
          error: interactionPending
            ? 'Master is waiting for an interactive answer'
            : 'Master did not accept the message',
          status: interactionPending ? 409 : 503,
          code: interactionPending
            ? 'INTERACTION_PENDING'
            : 'MASTER_MESSAGE_NOT_ACCEPTED',
        };
      }
      return { orchestrator: existing, resumed: false };
    } catch (err) {
      // A concurrent request may have recreated the worker after the route's
      // optimistic pool check but before this lock was acquired. Delivery is
      // still a mutating RPC, so a closed port means its outcome is unknown;
      // do not replay it on a replacement worker.
      if (isMutationOutcomeUnknownError(err)) {
        await evictCompanyOrchestrator(id);
        return {
          error:
            'Master message outcome_unknown: the worker acknowledgement was lost; ' +
            'the mutating RPC was not replayed.',
          status: 500,
          code: 'OUTCOME_UNKNOWN',
        };
      }
      return {
        error: `Master message failed: ${err instanceof Error ? err.message : String(err)}`,
        status: 500,
        code: 'MASTER_RESUME_FAILED',
      };
    }
  }

  await deps.sessionStore.ensureCatalog();
  let companyFiles: CompanySessionFiles;
  try {
    companyFiles = new CompanySessionFiles({
      companySessionId: id,
      sessionStore: deps.sessionStore,
    });
  } catch {
    return { error: 'Not found', status: 404 };
  }
  const session = companyFiles.getSession();

  let config: {
    role_assignments?: Parameters<CompanyOrchestrator['startMaster']>[0]['roleConfigs'];
  } = {};
  try { config = JSON.parse(session.config_json); } catch { /* defaults below */ }
  const roleConfigs = config.role_assignments ?? [];
  let masterRuntime;
  try {
    masterRuntime = resolveEffectiveMasterRuntime({
      configJson: session.config_json,
      runtimeKind: session.runtime_kind === 'app_studio' ? 'app_studio' : 'company',
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: 400,
    };
  }

  // A session that has a master run RESUMES it (reuses coder_session_id);
  // a brand-new sub-session with no master run cold-starts.
  const masterRun = companyFiles.listAgentRunsSync()
    .filter((r) => r.role === 'master')
    .pop();

  const attemptSpawnAndResume = async (): Promise<WorkerBackedOrchestrator> => {
    const { orchestrator } = await getOrSpawnCompanyOrchestrator(id);
    await resolveAndRunMaster(orchestrator, !!masterRun, {
      userMessage: opts.message,
      provider: masterRuntime.provider,
      model: masterRuntime.model,
      maxTurns: 100,
      roleConfigs,
      attachments: opts.attachments,
      thinking: opts.thinking ?? masterRuntime.thinking,
      thinkingBudgetTokens: masterRuntime.thinkingBudgetTokens,
      temperature: masterRuntime.temperature,
      reasoningEffort: masterRuntime.reasoningEffort,
      fallbackModels: masterRuntime.fallbackModels,
    });
    return orchestrator;
  };

  try {
    return { orchestrator: await attemptSpawnAndResume(), resumed: true };
  } catch (err) {
    // The worker may have applied start/resume and lost only the ACK. Replaying
    // that mutating RPC could duplicate the master/message, so fence the
    // handle and require an explicit new user action.
    await evictCompanyOrchestrator(id);
    if (isMutationOutcomeUnknownError(err)) {
      return {
        error:
          'Master resume outcome_unknown: the worker acknowledgement was lost; ' +
          'the mutating RPC was not replayed.',
        status: 500,
        code: 'OUTCOME_UNKNOWN',
      };
    }
    return {
      error: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
      status: 500,
      code: 'MASTER_RESUME_FAILED',
    };
  }
}
