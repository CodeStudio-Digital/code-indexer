/**
 * review_subordinate_work — master-only tool.
 *
 * Lets the master review a subordinate's file changes with the SAME configured
 * pipeline (snapshot_review/reviewer) the dashboard "Revisão automática" uses,
 * then decide whether to send corrections back via the existing
 * `forward_to_agent` tool.
 *
 * Snapshots are recorded per coder session, so we resolve the subordinate's
 * coder_session_id from `orchestrator.listSubordinates()` and review that
 * session. The heavy lifting lives in `reviewSessionSnapshots` (shared with the
 * code-agent `self_review` tool); this file is just orchestration glue.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { SessionSnapshotService } from '@mcp/services/services/session-snapshots.js';
import { SnapshotReviewPipeline } from '@mcp/services/services/snapshot-review-pipeline.js';
import { PipelineProviderResolver } from '@mcp/services/pipelines/index.js';
import { reviewSessionSnapshots } from '@mcp/services/services/review-session-snapshots.js';
import { formatFindingsForAgent } from '@mcp/services/services/snapshot-review-format.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { buildSessionIntent } from '@mcp/code-agent/sessions/session-intent.js';
import { asSessionId, isUuid } from '@mcp/session-storage';

export interface MasterReviewDeps {
  /** Essential provider/pipeline settings DB; contains no session state. */
  settingsDbHandle: ConstructorParameters<
    typeof PipelineProviderBindingsStore
  >[0];
  /** Filesystem authority for subordinate snapshots and review records. */
  sessionStore: FsSessionStore;
  /** Resolve a project's absolute root path by id (db.getProject(id).root_path). */
  getProjectRoot: (projectId: number) => string | null;
}

/** Pipeline-config problems (not transient) → an actionable hint, not a failure. */
const CONFIG_ERROR_CODES = new Set([
  'review_pipeline_unconfigured',
  'review_pipeline_provider_unsupported',
  'review_pipeline_missing_credentials',
]);

export function buildReviewSubordinateTool(
  orchestrator: CompanyOrchestrator,
  deps: MasterReviewDeps,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      agent_run_id: {
        type: 'string',
        description: 'UUID of the subordinate agent whose work you want reviewed (see list_subordinates).',
      },
    },
    required: ['agent_run_id'],
  };

  return {
    name: 'review_subordinate_work',
    description:
      "Review a subordinate's work with the configured review pipeline (snapshot_review/reviewer). " +
      "Reads that agent's file snapshots, runs the review, and returns the findings for YOU to judge. " +
      'If a finding is worth fixing, send it back with forward_to_agent(agent_run_id, message=...). ' +
      'Findings are also saved to the Snapshots panel.\n\n' +
      'WHEN TO USE: after a subordinate reports a non-trivial change done, before you finalize it. ' +
      'Call list_subordinates first to get the agent_run_id.',
    parameters,
    source: 'native',
    handler: async (args, ctx): Promise<ToolResult> => {
      ctx.signal?.throwIfAborted();
      const agentRunId =
        typeof args.agent_run_id === 'string' ? args.agent_run_id : '';
      if (!agentRunId) {
        return err('review_subordinate_work: agent_run_id is required.');
      }

      const sub = orchestrator.listSubordinates().find((s) => s.agentRunId === agentRunId);
      if (!sub) {
        return err(`review_subordinate_work: no subordinate with agent_run_id=${agentRunId}.`);
      }

      const coderSessionIdRaw = String(sub.coderSessionId);
      if (!isUuid(coderSessionIdRaw)) {
        return err('review_subordinate_work: subordinate has no filesystem session UUID.');
      }
      const coderSessionId = asSessionId(coderSessionIdRaw);
      const projectId = sub.projectIds[0];
      const projectRoot = projectId != null ? deps.getProjectRoot(projectId) : null;
      if (!projectRoot) {
        return err(
          `review_subordinate_work: could not resolve a project root for agent_run_id=${agentRunId}.`,
        );
      }

      const snapshotStore = deps.sessionStore;
      const reviewStore = deps.sessionStore;
      const snapshotService = new SessionSnapshotService(snapshotStore, (kind, sid) =>
        kind === 'coder' && sid === coderSessionId ? projectRoot : null,
      );
      const resolver = new PipelineProviderResolver(
        new PipelineProviderBindingsStore(deps.settingsDbHandle),
        new ProviderStore(deps.settingsDbHandle),
      );
      const pipeline = new SnapshotReviewPipeline(resolver);

      // The subordinate's first user message IS the task the master forwarded
      // to it — that plus its task list gives the reviewer the change's intent.
      let intent: string | null = null;
      try {
        intent = await buildSessionIntent(deps.sessionStore, coderSessionId);
      } catch {
        /* review runs without intent */
      }

      let outcome;
      try {
        outcome = await reviewSessionSnapshots(
          { snapshotStore, snapshotService, pipeline, reviewStore },
          coderSessionId,
          { intent, signal: ctx.signal },
        );
      } catch (e) {
        return err(`review_subordinate_work failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (!outcome.ok) {
        if (outcome.errorCode && CONFIG_ERROR_CODES.has(outcome.errorCode)) {
          return err(
            `review_subordinate_work unavailable: ${outcome.error ?? outcome.errorCode}. ` +
              'Configure snapshot_review/reviewer in Admin > Pipelines.',
          );
        }
        return err(`review_subordinate_work failed: ${outcome.error ?? 'unknown error'}`);
      }
      if (outcome.pendingHunks === 0) {
        return ok(`Agent ${agentRunId} (${sub.role}) has no pending changes to review.`);
      }

      const body = formatFindingsForAgent(outcome.findings);
      return ok(
        `Review of agent_run_id=${agentRunId} (${sub.role}):\n\n${body}\n\n` +
          `To send fixes back, call forward_to_agent(agent_run_id=${agentRunId}, message="...").`,
      );
    },
  };
}
