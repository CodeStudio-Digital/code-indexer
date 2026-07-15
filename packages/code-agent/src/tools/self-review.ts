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
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import { SessionFileReviewStore } from '@mcp/store/session-file-review-store.js';
import { ReviewIntelStore } from '@mcp/store/review-intel-store.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { SessionSnapshotService } from '@mcp/services/services/session-snapshots.js';
import { SnapshotReviewPipeline } from '@mcp/services/services/snapshot-review-pipeline.js';
import { PipelineProviderResolver } from '@mcp/services/pipelines/index.js';
import { reviewSessionSnapshots } from '@mcp/services/services/review-session-snapshots.js';
import { IntentContractCompiler } from '@mcp/services/services/intent-contract.js';
import { formatFindingsForAgent } from '@mcp/services/services/snapshot-review-format.js';
import type {
  ReviewReferenceHit,
  ReviewReferenceLookup,
} from '@mcp/services/services/review-absences.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { buildSessionIntent } from '@mcp/code-agent/sessions/session-intent.js';
import { buildVerifyEvidence, formatVerifyEvidence } from '@mcp/code-agent/core/review-evidence.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface SelfReviewDeps {
  /** Shared better-sqlite3 handle (store.getDb()) — never closed here. */
  dbHandle: DB;
  /** Coder session id whose snapshots get reviewed (the current session). */
  sessionId: number;
  /** Absolute root of the PRIMARY project, for resolving on-disk file content. */
  projectRoot: string;
  /** Linked SECONDARY roots for a global session, so snapshots of files edited
   *  in another project resolve to the right root. Empty for normal sessions. */
  secondaryRoots?: ReadonlyArray<{ projectId: number; rootPath: string }>;
  /** Session tool registry — lets the review resolve references through the
   *  same `mcp__find_references` the model uses (absence detection). Optional
   *  so tests and legacy call sites keep working without it. */
  registry?: ToolRegistry;
  /** Primary project id — scopes fate-tracking priors to THIS repo. */
  projectId?: number;
}

/** Per-symbol budget for a reference lookup — an index hiccup must degrade
 *  to a no-absences review, never stall the whole self_review call. */
const REFERENCE_LOOKUP_TIMEOUT_MS = 5_000;

function parseReferenceHits(content: string): ReviewReferenceHit[] {
  const parsed = JSON.parse(content) as {
    references?: Array<{ file_path?: unknown; line?: unknown; context?: unknown }>;
  };
  if (!Array.isArray(parsed.references)) return [];
  const hits: ReviewReferenceHit[] = [];
  for (const ref of parsed.references) {
    if (typeof ref?.file_path !== 'string' || !ref.file_path) continue;
    hits.push({
      filePath: ref.file_path,
      line: typeof ref.line === 'number' && Number.isFinite(ref.line) ? ref.line : null,
      context: typeof ref.context === 'string' ? ref.context : null,
    });
  }
  return hits;
}

/**
 * Reference lookup over the session's own registry (`mcp__find_references`,
 * format=json). Absent tool / unindexed project / timeout → empty result,
 * which buildAbsenceReport treats as "no absences for this symbol".
 */
function buildRegistryReferenceLookup(
  registry: ToolRegistry,
  ctx: ToolContext,
): ReviewReferenceLookup {
  return {
    async findReferences(symbolName: string): Promise<ReviewReferenceHit[]> {
      const invoke = registry.invoke(
        'mcp__find_references',
        { project_name: ctx.projectName, symbol_name: symbolName, format: 'json' },
        ctx,
      );
      const timeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), REFERENCE_LOOKUP_TIMEOUT_MS).unref?.(),
      );
      const result = await Promise.race([invoke, timeout]);
      if (!result || result.isError) return [];
      return parseReferenceHits(result.content);
    },
  };
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
      'Optionally pass `focus` — a short note on what you changed and where to look — ' +
      'to sharpen the review.\n' +
      "DON'T: call on every turn or for read-only/trivial work — it costs a model call. " +
      'For a heavier independent second opinion on an arbitrary diff, use request_review instead.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description:
            'Optional. 1-3 sentences on what you changed and where the reviewer should pay extra attention.',
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const snapshotStore = new SessionFileSnapshotStore(deps.dbHandle);
      const reviewStore = new SessionFileReviewStore(deps.dbHandle);
      const snapshotService = new SessionSnapshotService(snapshotStore, (kind, sessionId, projectId) => {
        if (kind !== 'coder' || sessionId !== deps.sessionId) return null;
        // Global session: a baseline may belong to a linked secondary root.
        if (projectId != null) {
          const sec = deps.secondaryRoots?.find((r) => r.projectId === projectId);
          if (sec) return sec.rootPath;
        }
        return deps.projectRoot;
      });
      const resolver = new PipelineProviderResolver(
        new PipelineProviderBindingsStore(deps.dbHandle),
        new ProviderStore(deps.dbHandle),
      );
      const pipeline = new SnapshotReviewPipeline(resolver);

      const focus =
        typeof args.focus === 'string' && args.focus.trim() ? args.focus.trim() : undefined;
      // Session intent (title + original request + task list) is best-effort
      // context — a store hiccup must not block the review itself.
      let intent: string | null = null;
      try {
        intent = buildSessionIntent(new SessionStore(deps.dbHandle), deps.sessionId);
      } catch {
        /* review runs without intent */
      }

      // Recorded verification evidence (which verify commands actually ran +
      // staleness) replaces author claims. Best-effort like intent.
      const evidenceData = buildVerifyEvidence(deps.dbHandle, deps.sessionId);
      const evidence = evidenceData ? formatVerifyEvidence(evidenceData) : null;

      // Absence detection needs the reference index; skip when the project
      // was never indexed (the tool would fall back to a slow disk grep).
      const referenceLookup =
        deps.registry?.has('mcp__find_references') && ctx.projectIndexed !== false
          ? buildRegistryReferenceLookup(deps.registry, ctx)
          : undefined;

      // Learning + alignment surfaces (migration 224): fate tracking priors
      // and the compiled intent contract. Both degrade silently when the
      // migration has not run yet.
      let intelStore: ReviewIntelStore | undefined;
      let intentCompiler: IntentContractCompiler | undefined;
      try {
        intelStore = new ReviewIntelStore(deps.dbHandle);
        intentCompiler = new IntentContractCompiler(resolver, intelStore);
      } catch {
        /* review runs without priors/contract */
      }

      let outcome;
      try {
        outcome = await reviewSessionSnapshots(
          {
            snapshotStore,
            snapshotService,
            pipeline,
            reviewStore,
            referenceLookup,
            intelStore,
            intentCompiler,
            projectId: deps.projectId,
          },
          deps.sessionId,
          { focus, intent, evidence },
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
      // structuredData carries the typed findings so code_exec scripts (and
      // any programmatic consumer) can iterate them instead of re-parsing
      // the human-oriented text.
      return {
        content: formatFindingsForAgent(outcome.findings),
        structuredData: {
          pendingHunks: outcome.pendingHunks,
          findings: outcome.findings,
          obligations: outcome.obligations ?? null,
          providerId: outcome.providerId ?? null,
          modelId: outcome.modelId ?? null,
        },
      };
    },
  };
}
