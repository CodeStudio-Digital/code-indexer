/**
 * self_review — run the configured snapshot_review/reviewer pipeline over the
 * files THIS session has edited (its active snapshots) and return the findings.
 *
 * Unlike `request_review` (which spawns a fresh read-only reviewer subagent and
 * needs you to hand it a spec + diff), `self_review` reuses the SAME pipeline
 * the dashboard "Revisão automática" button uses, reads the session's own
 * snapshots automatically, and persists the findings into the Snapshots panel.
 * It is cheap (no subagent) and meant to be called near the end of a task so
 * the agent validates its own work before claiming done. The agent then decides
 * which findings to accept and applies the fixes with edit_file/multi_edit.
 *
 * Always registered (bootstrap tier). A settings toggle (CODER_SELF_REVIEW)
 * only controls the proactive reminder, not availability.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import { SessionFileReviewStore } from '@mcp/store/session-file-review-store.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { SessionSnapshotService } from '@mcp/services/services/session-snapshots.js';
import { SnapshotReviewPipeline } from '@mcp/services/services/snapshot-review-pipeline.js';
import { PipelineProviderResolver } from '@mcp/services/pipelines/index.js';
import { reviewSessionSnapshots } from '@mcp/services/services/review-session-snapshots.js';
import { formatFindingsForAgent } from '@mcp/services/services/snapshot-review-format.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface SelfReviewDeps {
  /** Shared better-sqlite3 handle (store.getDb()) — never closed here. */
  dbHandle: DB;
  /** Coder session id whose snapshots get reviewed (the current session). */
  sessionId: number;
  /** Absolute project root, for resolving on-disk file content. */
  projectRoot: string;
}

/** Pipeline-config problems (not transient) → an actionable hint, not a failure. */
const CONFIG_ERROR_CODES = new Set([
  'review_pipeline_unconfigured',
  'review_pipeline_provider_unsupported',
  'review_pipeline_missing_credentials',
]);

export function buildSelfReviewTool(deps: SelfReviewDeps): CoderTool {
  return {
    name: 'self_review',
    source: 'native',
    mutates: false,
    parallelSafe: false,
    riskLevel: 'read',
    repeatable: true,
    description:
      'Review YOUR OWN work this session with the configured review pipeline ' +
      '(snapshot_review/reviewer). Reads the active snapshots of this session (the files you ' +
      'edited), runs the same review the dashboard "Revisão automática" uses, and returns ' +
      'findings with severity + a concrete suggestedFix. You then decide which to accept and ' +
      'apply the fixes with edit_file/multi_edit. Findings are also saved to the Snapshots panel.\n\n' +
      'WHEN TO USE: right before you tell the user a non-trivial change is done; after a ' +
      'multi-file edit; after a security-sensitive fix.\n' +
      "DON'T: call on every turn or for read-only/trivial work — it costs a model call. " +
      'For a heavier independent second opinion on an arbitrary diff, use request_review instead.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async (): Promise<ToolResult> => {
      const snapshotStore = new SessionFileSnapshotStore(deps.dbHandle);
      const reviewStore = new SessionFileReviewStore(deps.dbHandle);
      const snapshotService = new SessionSnapshotService(snapshotStore, (kind, sessionId) =>
        kind === 'coder' && sessionId === deps.sessionId ? deps.projectRoot : null,
      );
      const resolver = new PipelineProviderResolver(
        new PipelineProviderBindingsStore(deps.dbHandle),
        new ProviderStore(deps.dbHandle),
      );
      const pipeline = new SnapshotReviewPipeline(resolver);

      let outcome;
      try {
        outcome = await reviewSessionSnapshots(
          { snapshotStore, snapshotService, pipeline, reviewStore },
          deps.sessionId,
        );
      } catch (e) {
        return err(`self_review failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (!outcome.ok) {
        if (outcome.errorCode && CONFIG_ERROR_CODES.has(outcome.errorCode)) {
          return err(
            `self_review unavailable: ${outcome.error ?? outcome.errorCode}. ` +
              'Configure snapshot_review/reviewer in Admin > Pipelines.',
          );
        }
        return err(`self_review failed: ${outcome.error ?? 'unknown error'}`);
      }
      if (outcome.pendingHunks === 0) {
        return ok('No pending changes in this session to review.');
      }
      return ok(formatFindingsForAgent(outcome.findings));
    },
  };
}
