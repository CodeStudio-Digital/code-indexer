import { UltraAgentBudget } from './runtime/ultra-budget.js';
import { CollaborationBudget } from '@mcp/session-storage/collaboration/budget.js';
import { budgetedProvider } from './runtime/ultra-provider.js';
import { CollaborationFiles } from '@mcp/session-storage/collaboration/files.js';
import { CollaborationRevisions } from '@mcp/session-storage/collaboration/revisions.js';
import { CollaborationFollowups } from '@mcp/session-storage/collaboration/followups.js';
import { reconcileUltraBudget } from './runtime/ultra-budget-recovery.js';
import { chatChangesTools } from './tools/chat-changes.js';
import { buildResumeChatTool } from './tools/chat-resume.js';
import { resolveUltraPreset } from './sessions/ultra-policy.js';
import { chatCollaborationTools } from './tools/chat-collaboration.js';
import { sessionNetworkTools } from './tools/session-network.js';
import { ultraFollowupTools } from './tools/ultra-followups.js';
import { SessionNetwork } from './runtime/session-network.js';
import { createRootCollaboration, attachChatMailbox } from './runtime/chat-collaboration.js';
import { resolve as resolvePath, join as joinPath, relative as relativePath, isAbsolute as isAbsolutePath } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { CodeIndexDB } from '@mcp/store/db.js';
import { loadConfig, mcpDataDir } from '@mcp/shared/utils/config.js';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { ChatProvider, CoderProviderName } from '@mcp/code-agent/providers/adapter.js';
import type { PromptContextMeasurement } from '@mcp/provider-sdk/prompt-cache-metrics.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { admitCoderAttempt, prepareCoderAttempt } from './runtime/attempt-preparation.js';
import { asAgentRunId } from '@mcp/agent-runtime-contracts';
import { nestedToolCallUseId, type ToolSettledEvent } from '@mcp/code-agent/core/tool.js';
import { createSessionOutcomeRecovery } from './sessions/outcome-recovery.js';
import { changedToolPaths } from './runtime/changed-tool-paths.js';
import { inlineRunProjection } from './tools/execute-tasks/inline-run-projection.js';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { tunablesFromRuntimePolicy } from '@mcp/code-agent/core/tunables.js';
import { FsTurnTelemetryRepository } from '@mcp/session-storage/fs-store/turn-telemetry.js';
import { traceStorageOperation, measureStorage, recordStorageElapsed } from '@mcp/session-storage/storage-timing.js';
import { createPolicyShadowPort } from '@mcp/code-agent/core/policy-shadow-adapter.js';
import { hasStructuredToolTruncation } from '@mcp/code-agent/core/runner/tool-output-telemetry.js';
import type {
  CompactionCheckpoint,
  CompactionCheckpointResult,
} from '@mcp/code-agent/core/runner/types.js';
import { parseToolOutputCapLevel, levelFromLegacyBoolean } from '@mcp/code-agent/core/runner/output-caps.js';
import { PermissionGate, normalizeToolPermissionMode } from '@mcp/code-agent/core/permission-gate.js';
import { shouldEnableEphemeralSubagents } from '@mcp/code-agent/core/ephemeral-subagent-capability.js';
import { loadAgentsMd } from '@mcp/code-agent/core/agents-md.js';
import { formatIdeContext } from '@mcp/code-agent/core/ide-context.js';
import {
  buildConfigLock,
  diffConfigLock,
  normalizeConfigLock,
} from '@mcp/code-agent/sessions/session-config.js';
import {
  detectTurnUltraKeyword,
  resolveSessionExecutionPolicy,
  type SessionExecutionPolicy,
} from '@mcp/code-agent/sessions/execution-mode.js';
import { harvestCompactionMemory } from '@mcp/code-agent/core/runner/compaction/memory-harvest.js';
import {
  persistChapterCheckpoint,
  serializeSessionCompaction,
} from '@mcp/code-agent/core/runner/compaction/chapter-checkpoint.js';
import { DurableCheckpointCoordinator } from '@mcp/code-agent/core/runner/compaction/checkpoint-retry.js';
import { durableCompactionEnabled } from '@mcp/code-agent/core/runner/compaction/threshold.js';
import {
  summaryV3ToV2,
} from '@mcp/code-agent/core/summarizer.js';
import {
  appendStaticPromptSection,
  buildSystemPrompt,
  normalizeProviderFamily,
  promoteIndexReadySystemPrompt,
  type PromptContext,
} from '@mcp/code-agent/core/system-prompt.js';
import { buildRepoMap, resolveRepoMapBudget } from '@mcp/code-agent/core/repo-map.js';
import { detectVerifyCommands } from '@mcp/code-agent/core/verify-commands.js';
import { buildVerifyEvidence } from '@mcp/code-agent/core/review-evidence.js';
import { workspaceFromProject, type WorkspaceContext } from '@mcp/code-agent/core/workspace.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import {
  canonicalizeExternalRoot,
  resolveWorkspacePath,
} from '@mcp/code-agent/tools/paths.js';
import { applyPatchTool } from '@mcp/code-agent/tools/apply-patch.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { gitToolsForProject } from '@mcp/code-agent/tools/git.js';
import {
  defaultLocalFilesystemPort,
  defaultLocalShellPort,
  SnapshotRecorder,
  SnapshotRecordingFilesystemPort,
} from '@mcp/code-agent/ports/index.js';
import { SessionSnapshotService } from '@mcp/services/services/session-snapshots.js';
import { filterReviewableDiffs } from '@mcp/services/services/snapshot-review-ignore.js';
import { SandboxFilesystemAdapter } from '@mcp/services/sandbox/adapters/sandbox-filesystem-adapter.js';
import { SandboxShellAdapter } from '@mcp/services/sandbox/adapters/sandbox-shell-adapter.js';
import { approvedPlanForRevision, planTools } from '@mcp/code-agent/tools/plan.js';
import { specTools } from '@mcp/code-agent/tools/spec/index.js';
import {
  tasksTools,
  listTasks,
  cancelTasks,
  deleteTasks,
  archiveTaskList,
  // Frente D — `executeTask` (singular) removed: `execute_tasks` (plural,
  // wave-based) is the single orchestration entry point. `taskComplete`
  // stays because inline-mode scope closure inside `execute_tasks` still
  // depends on it (the agent's "I finished this inline turn" signal).
  taskComplete,
  updateTask,
} from '@mcp/code-agent/tools/tasks.js';
import { interactionTools } from '@mcp/code-agent/tools/interaction.js';
import { buildFindToolsTool } from '@mcp/code-agent/tools/find-tools.js';
import { buildRequestReviewTool } from '@mcp/code-agent/tools/request-review.js';
import { buildSelfReviewTool } from '@mcp/code-agent/tools/self-review.js';
import { McpToolBridge } from '@mcp/code-agent/tools/mcp-bridge.js';
import { buildMcpResourceTools } from '@mcp/code-agent/tools/mcp-resources.js';
import { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import {
  createSubagentProviderResolver,
  providerForProfile,
  resolveSubagentExecutionEffort,
  type ProfileLimitOverride,
  type SubagentTarget,
} from '@mcp/code-agent/tools/subagent-provider.js';
import {
  SUBAGENT_PROFILE_IDS,
  type MicroAgentProfileId,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
import { buildSpawnAgentTool } from '@mcp/code-agent/tools/spawn-agent.js';
import { loadPrompt, interpolate } from '@mcp/code-agent/prompts/loader.js';
import { buildDiagramGuidance } from '@mcp/code-agent/prompts/diagram-guidance.js';
import { buildMasterTools } from '@mcp/company/tools/master-tools.js';
import { buildKanbanTools } from '@mcp/company/tools/kanban-tools.js';
import { buildBoardTools } from '@mcp/company/tools/board-tools.js';
import { buildQaTools, roleHasQaPlaywrightSkill } from '@mcp/company/tools/qa/index.js';
import { buildSubordinateTools } from '@mcp/company/tools/subordinate-tools.js';
import { buildSharedDriveTools } from '@mcp/company/tools/shared-drive-tools.js';
import { sandboxTools } from '@mcp/company/tools/sandbox-tools.js';
import { serviceTools } from '@mcp/company/tools/service-tools.js';
import { docsTools } from '@mcp/company/tools/docs-tools.js';
import { envTools } from '@mcp/company/tools/env-tools.js';
import { buildSubordinateKanbanTools } from '@mcp/company/tools/subordinate-kanban-tools.js';
import { isMasterAllowed } from '@mcp/company/tools/master-filter.js';
import { withCompanyToolsMetadata } from '@mcp/company/tools/metadata.js';
import { RuntimeHookRegistry } from '@mcp/code-agent/core/hook-registry.js';
import { registerCompanyHooks } from '@mcp/code-agent/core/company-hooks.js';
import { createRuntimeHookBus } from '@mcp/code-agent/core/hook-bus.js';
import {
  contextualTiersForRuntime,
  profileToTiers,
  getToolTier,
  type CoderProfile,
  type ToolTier,
} from '@mcp/code-agent/tools/tiers.js';
import { parseToolsetState, resolveSessionProfile } from '@mcp/code-agent/tools/profile-resolution.js';
import { getModelMaxTools } from '@mcp/code-agent/providers/capabilities.js';
import { renderPreflightHint } from '@mcp/code-agent/core/runner/assembly/preflight-hint.js';
import {
  type ReadProject,
  perProjectIndexLimit,
  mergeMemoryIndex,
  interleaveLabeled,
  mapProjectsConcurrent,
} from '@mcp/code-agent/core/runner/assembly/union-memory.js';
import { AGENTS, isAgentId, type AgentId } from '@mcp/code-agent/agents/index.js';
import { decisionGuidanceForTask, decisionTelemetryForTask } from '@mcp/code-agent/agents/decision-engine.js';
import { classifyIntent } from '@mcp/code-agent/agents/task-intent.js';
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { toolOutputTools } from '@mcp/code-agent/tools/tool-output.js';
import { diagnosticsTools } from '@mcp/code-agent/tools/diagnostics.js';
import { lspTools } from '@mcp/code-agent/tools/lsp.js';
import { execCommandTools } from '@mcp/code-agent/tools/exec-command.js';
import { webTools } from '@mcp/code-agent/tools/web.js';
import { httpTools } from '@mcp/code-agent/tools/http.js';
import { apiClientTools } from '@mcp/code-agent/tools/api-client/index.js';
import { dbTools } from '@mcp/code-agent/tools/db/index.js';
import { diagramTools } from '@mcp/code-agent/tools/diagram/index.js';
import { globTools } from '@mcp/code-agent/tools/glob.js';
import { getGlobalDocSearch, ragSearchDocsTools } from '@mcp/code-agent/tools/rag-search-docs.js';
import { prefixedBridgeTools, primaryBridgeTools, pruneRedundantPrimaryTwins } from '@mcp/code-agent/tools/internal-mcp-exposure.js';
import { sessionFileKnowledge } from '@mcp/code-agent/tools/file-knowledge.js';
import { ragReadDocTools } from '@mcp/code-agent/tools/rag-read-doc.js';
import { ragDocOutlineTools } from '@mcp/code-agent/tools/rag-doc-outline.js';
import { generateTodoId } from '@mcp/code-agent/tools/todo.js';
import { type TodoItem, buildTrackState } from '@mcp/code-agent/tools/task-list-shared.js';
import { viewImageTools } from '@mcp/code-agent/tools/view-image.js';
import { previewTools } from '@mcp/code-agent/tools/preview/index.js';
import { browserTools, isResearchToolAllowed } from '@mcp/code-agent/tools/browser/index.js';
import { buildSessionDriveTools } from '@mcp/code-agent/tools/session-drive-tools.js';
import { buildConversationChapterTools } from '@mcp/code-agent/tools/conversation-chapters.js';
import { buildProjectMemoryTools } from '@mcp/code-agent/tools/project-memory-tools.js';
import { buildAutoCapture } from '@mcp/code-agent/sessions/auto-capture.js';
import { hasResumableInteractiveToolUse } from '@mcp/code-agent/sessions/interactive-tools.js';
import { getInvestigationSemanticIndex } from '@mcp/code-agent/tools/investigation-embedder.js';
import { buildCodeExecTool } from '@mcp/code-agent/tools/code-exec.js';
import {
  collectRuntimeToolTiers,
  mergeRuntimeTierSummaries,
} from '@mcp/code-agent/tools/runtime-tool-tiers.js';
import { createCodeExecStash } from '@mcp/code-agent/tools/code-exec-stash.js';
import { listAgentsTools } from '@mcp/code-agent/tools/list-agents.js';
import { waitAgentsTools } from '@mcp/code-agent/tools/wait-agents.js';
import { sendMessageTools } from '@mcp/code-agent/tools/send-message.js';
import { sendInputTools } from '@mcp/code-agent/tools/send-input.js';
import { followupTaskTools } from '@mcp/code-agent/tools/followup-task.js';
import { worktreeTools, createProjectWorktree } from '@mcp/code-agent/tools/worktree.js';
import { resolveProjectWorktree, resolveSessionWorkspaceRoot } from '@mcp/code-agent/tools/project-worktrees.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import type { ResolvedSkill, SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import { resolveActiveWorkspaceSkills } from '@mcp/code-agent/skills/workspace-skills.js';
import { buildInvokeSkillTool, buildSkillDiscoveryTools } from '@mcp/code-agent/skills/skill-tool-builder.js';
import { buildCreateSkillTool } from '@mcp/code-agent/tools/create-skill.js';
import { listInstalledNamespaces } from '@mcp/code-agent/skills/agent-skills-installer.js';
import {
  buildLazySkillsSection,
  buildMatchedSkillsPromptSection,
} from '@mcp/code-agent/skills/prompt-injector.js';
import { skillAsCatalogCapability } from '@mcp/code-agent/core/capability-catalog.js';
import { matchSkills, type SkillMatchContext } from '@mcp/code-agent/skills/skill-matcher.js';
import {
  BundleToolOutputStore,
  FsPolicyShadowRepository,
  FsSessionStore,
  requireSessionProjectAuthority,
  type FsCoderSession,
} from '@mcp/session-storage/fs-store/index.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { PipelineProviderResolver } from '@mcp/services/pipelines/index.js';
import type { CoderExecutionMode } from '@mcp/session-storage/session-state-types.js';
import { attachmentsToBlocks, type AgentMessage, type ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';

// Public types live in ./index/types.ts (extracted to keep this file under
// the LOC cap). Re-exported below so external consumers of @mcp/code-agent
// continue to see them on the package root.
import type {
  CoderAttachment,
  IndexStatus,
  MasterStartResult,
  PreflightSeed,
  RunCoderHandle,
  RunCoderOptions,
} from './index/types.js';
export type { CoderAttachment, IndexStatus, MasterStartResult, PreflightSeed, RunCoderHandle, RunCoderOptions };
import { extractFilePathsFromText, defaultModelFor } from './index/helpers.js';

// (Type bodies moved to './index/types.ts'.)

/**
 * Module-level lazy singleton for the incremental indexer.
 *
 * Why a singleton and not a static import?
 *   - `@mcp/indexer/indexer/incremental` instantiates a `TreeSitterExtractor`
 *     and `initTreeSitter()` (WASM load) at module-eval time.
 *   - Sessions that never edit code (plan-mode / pure investigation)
 *     should pay ZERO of that cost.
 *
 * Why a singleton and not `await import(...)` in the hook?
 *   - The hook fires on every successful mutating tool call. Without
 *     memoisation each call creates an extra Promise + microtask, even
 *     though ESM caches the actual module after the first load.
 *   - Promise.all-style concurrent edits in the same turn would also
 *     trigger N parallel resolutions; the singleton dedupes them.
 *
 * Cached as a Promise (not the resolved function) so concurrent first-
 * callers race on the SAME load instead of starting two of them.
 */
let incrementalIndexerPromise:
  | Promise<typeof import('@mcp/indexer/indexer/incremental.js').indexFileNow>
  | null = null;
function loadIncrementalIndexer(): Promise<
  typeof import('@mcp/indexer/indexer/incremental.js').indexFileNow
> {
  if (!incrementalIndexerPromise) {
    incrementalIndexerPromise = import('@mcp/indexer/indexer/incremental.js')
      .then((mod) => mod.indexFileNow);
  }
  return incrementalIndexerPromise;
}

/**
 * Process-wide shared central DB handles (anti-freeze, Phase 2).
 *
 * `runCoder` used to open a FRESH `CodeIndexDB` + `SessionStore` (two
 * better-sqlite3 connections to the central file) on EVERY call and close them
 * at run end. In a company worker the master + up to 10 subordinates each call
 * `runCoder`, so that was ~22 short-lived connections to ONE SQLite file inside
 * ONE worker thread — heavy WAL writer-lock contention that (with the event
 * firehose) froze the backend during multi-agent runs.
 *
 * Now every `runCoder` in a process SHARES one `CodeIndexDB` and one
 * filesystem `FsSessionStore`. SQLite remains open only for the essential
 * project/provider/index catalogs; session writes never share that handle.
 * Keyed by `dbPath` and guarded against a second path. Process-owned and
 * intentionally NOT closed per-run: a
 * process-`exit` hook plus the explicit `closeSharedCentral()` (called from the
 * company-worker stop handler) close them once on teardown.
 */
let sharedCentral: {
  dbPath: string;
  db: CodeIndexDB;
  store: FsSessionStore;
} | null = null;
let sharedCentralExitHookInstalled = false;

function getSharedCentral(dbPath: string, writerOwnerId?: string): {
  db: CodeIndexDB;
  store: FsSessionStore;
} {
  if (sharedCentral && sharedCentral.dbPath !== dbPath) {
    throw new Error(
      `runCoder central DB already opened against ${sharedCentral.dbPath}; cannot reuse for ${dbPath}`,
    );
  }
  if (!sharedCentral) {
    const db = new CodeIndexDB(dbPath);
    const projectRootResolver = {
      resolveProjectRoot: (projectId: number) => {
        const project = db.getProject(projectId);
        return project && !project.is_synthetic
          ? project.root_path
          : undefined;
      },
      listProjectRoots: () =>
        db
          .listProjectsForGlobalPicker()
          .filter((project) => !project.is_synthetic)
          .map((project) => ({
            project_id: project.id,
            root_path: project.root_path,
          })),
    };
    const store = FsSessionStore.fromRoots({
      dataDir: mcpDataDir(),
      projectRootResolver,
      ...(writerOwnerId ? { writerOwnerId } : {}),
      projectInfoResolver: (projectId) => {
        const project = db.getProject(projectId);
        return project && !project.is_synthetic
          ? {
              project_id: project.id,
              name: project.name,
              root_path: project.root_path,
            }
          : null;
      },
    });
    sharedCentral = { dbPath, db, store };
    if (!sharedCentralExitHookInstalled) {
      sharedCentralExitHookInstalled = true;
      // 'exit' is sync-only (db.close() is sync) and does not override signal
      // handling the way a SIGINT/SIGTERM listener would. Graceful teardown
      // goes through closeSharedCentral() in the worker stop handler.
      process.on('exit', () => closeSharedCentral());
    }
  }
  return { db: sharedCentral.db, store: sharedCentral.store };
}

/**
 * Process-owned filesystem session authority used by Company and other
 * in-process orchestrators that must create/configure a bundle before
 * `runCoder` starts. This accessor never constructs the legacy SQLite session
 * store and returns the exact same instance consumed by every runner.
 */
export function getSharedSessionStore(
  dbPath: string,
  writerOwnerId?: string,
): FsSessionStore {
  return getSharedCentral(dbPath, writerOwnerId).store;
}

/**
 * Close the shared central handles. Idempotent. Called on process exit and
 * explicitly from the company-worker stop handler for a graceful flush.
 */
export async function closeSharedCentral(): Promise<void> {
  if (!sharedCentral) return;
  const held = sharedCentral;
  sharedCentral = null;
  try { await held.store.close(); } catch { /* best-effort lease release */ }
  try { held.db.close(); } catch { /* best-effort */ }
}

type RunCoderExecutionSession = Pick<
  FsCoderSession,
  'id' | 'execution_mode_override' | 'reasoning_effort_override'
>;

type RunCoderExecutionStore = Pick<
  FsSessionStore,
  'setSessionExecutionMode' | 'setSessionReasoningEffort'
>;

export interface RunCoderExecutionResolution {
  sessionExecutionMode: CoderExecutionMode;
  storedReasoningEffort: string | null;
  policy: SessionExecutionPolicy;
}

/**
 * Persist the direct `runCoder` execution contract before resolving runtime
 * policy. This keeps Ultra host-owned: the legacy `reasoningEffort=ultra`
 * spelling upgrades the sticky execution mode, but is never written to the
 * provider-effort column. An explicit execution mode always wins conflicts.
 *
 * Exported for focused contract tests; callers should normally use runCoder.
 */
export async function resolveAndPersistRunCoderExecutionPolicy(
  store: RunCoderExecutionStore,
  session: RunCoderExecutionSession,
  request: Pick<RunCoderOptions, 'executionMode' | 'reasoningEffort'>,
): Promise<RunCoderExecutionResolution> {
  const explicitMode = request.executionMode;
  const hasRequestedEffort = request.reasoningEffort != null;
  const requestedEffort = request.reasoningEffort?.trim() || undefined;
  const storedEffort = session.reasoning_effort_override?.trim() || undefined;
  const requestedLegacyUltra = requestedEffort?.toLowerCase() === 'ultra';
  const storedLegacyUltra = storedEffort?.toLowerCase() === 'ultra';

  const sessionExecutionMode: CoderExecutionMode = explicitMode
    ?? (requestedLegacyUltra || storedLegacyUltra
      ? 'ultra'
      : session.execution_mode_override ?? 'standard');

  // An explicit mode (including `standard`) owns the mode decision. Persist
  // direct requests even when the row already has that value, so every
  // runCoder entry surface has one durable contract before policy resolution.
  if (
    explicitMode !== undefined
    || requestedLegacyUltra
    || storedLegacyUltra
    || session.execution_mode_override !== sessionExecutionMode
  ) {
    await store.setSessionExecutionMode(session.id, sessionExecutionMode);
  }

  // Repair legacy rows without ever sending the sentinel through the generic
  // reasoning-effort setter. Native values remain untouched and can become
  // active again if a later run explicitly returns to Standard mode.
  if (storedLegacyUltra) {
    await store.setSessionReasoningEffort(session.id, null);
  }

  const selectedNativeEffort = hasRequestedEffort
    ? (requestedLegacyUltra ? undefined : requestedEffort)
    : (storedLegacyUltra ? undefined : storedEffort);
  const policy = resolveSessionExecutionPolicy(
    sessionExecutionMode,
    selectedNativeEffort,
  );

  return {
    sessionExecutionMode,
    storedReasoningEffort: storedLegacyUltra
      ? null
      : session.reasoning_effort_override,
    policy,
  };
}

/**
 * Build a fully-wired runner for a coder session and start it.
 *
 * Both the CLI and the SSE handler use this. Listeners should be attached
 * to `handle.runner` BEFORE awaiting `handle.done`.
 */
export function runCoder(opts: RunCoderOptions): Promise<RunCoderHandle> {
  return initializeCoder(opts);
}

async function initializeCoder(opts: RunCoderOptions): Promise<RunCoderHandle> {
  const config = loadConfig();
  // Shared per-process central handles — see getSharedCentral. One connection
  // for the whole worker instead of one per master/subordinate run.
  const { db, store } = getSharedCentral(config.dbPath);

  // Resolve or create the session. `agent` is persisted on the session row so
  // resume paths (/continue, reattach) honour the user's preset even when the
  // request body doesn't re-send it.
  let session: FsCoderSession;
  if ('id' in opts.session) {
    const found = await store.getSession(opts.session.id);
    if (!found) throw new Error(`Session ${opts.session.id} not found`);
    session = found;
  } else {
    session = await store.createSession({
      project_id: opts.session.create.project_id,
      title: opts.session.create.title,
      provider: opts.session.create.provider,
      model: opts.session.create.model ?? defaultModelFor(opts.session.create.provider),
      agent: opts.agentSelectionId ?? opts.agent ?? null,
    });
  }

  const executionResolution = await resolveAndPersistRunCoderExecutionPolicy(
    store,
    session,
    opts,
  );
  session = {
    ...session,
    execution_mode_override: executionResolution.sessionExecutionMode,
    reasoning_effort_override: executionResolution.storedReasoningEffort,
  };
  const sessionExecutionMode = executionResolution.sessionExecutionMode;
  // P2 (ultra-agent parity): the `ultracode` keyword upgrades THIS run to the
  // full Ultra posture (max reasoning + workflow tool + proactive delegation)
  // WITHOUT persisting anything — the sticky execution mode stays whatever the
  // user selected. Costs one prompt-cache re-prime on the turn (tool array +
  // posture block change), which the explicit keyword opt-in justifies.
  const turnUltraTriggered = detectTurnUltraKeyword(
    opts.userMessage,
    executionResolution.policy.ultraEnabled,
  );
  const ultraExecutionEnabled = executionResolution.policy.ultraEnabled || turnUltraTriggered;
  const effectiveReasoningEffort = executionResolution.policy.reasoningEffort;
  if (turnUltraTriggered) {
    console.log(`[coder s=${session.id}] ultracode keyword — Ultra posture for this run only`);
  }

  // Sticky agent: if the caller didn't specify one, fall back to the value
  // stored on the session. If they did and it differs, persist the new choice.
  const storedAgent: AgentId | null =
    session.agent && isAgentId(session.agent) ? session.agent : null;
  const effectiveAgentId: AgentId | null = opts.agent ?? storedAgent;
  const requestedSelectionId = opts.agentSelectionId ?? opts.agent;
  if (requestedSelectionId && requestedSelectionId !== session.agent) {
    await store.setSessionAgent(session.id, requestedSelectionId);
    session = { ...session, agent: requestedSelectionId };
  }

  // Apply agent defaults for any unspecified knob. This way explicit opts win
  // over presets (e.g. `--agent build --plan` keeps plan mode on), but resume
  // requests with no opts still inherit the preset's profile/planMode.
  const agentDef = effectiveAgentId ? AGENTS[effectiveAgentId] : null;
  if (agentDef) {
    if (opts.profile === undefined) opts = { ...opts, profile: agentDef.profile };
    if (opts.planMode === undefined) opts = { ...opts, planMode: agentDef.planMode };
    // Stay-in-Build invariant: on a RESUME, the persisted agent is authoritative
    // for plan mode. A non-plan agent (e.g. `build`, after a plan→build approval)
    // must NOT re-enter plan mode even if the client forwarded a stale
    // `plan_mode: true` in the resume body — the dashboard's plan-response resume
    // used to do exactly that, so a resumed build run re-engaged the plan gate and
    // the model got pushed to submit a second plan. Scoped to `resume` so explicit
    // non-resume starts like `--agent build --plan` still keep plan mode on.
    if (opts.resume && agentDef.planMode === false && opts.planMode) {
      opts = { ...opts, planMode: false };
    }
  }

  const projectAuthority = requireSessionProjectAuthority(
    session,
    (projectId) => {
      const current = db.getProject(projectId);
      return current && !current.is_synthetic
        ? {
            project_id: current.id,
            name: current.name,
            root_path: current.root_path,
          }
        : null;
    },
  );
  const registeredProject = db.getProject(projectAuthority.primary.project_id);
  if (!registeredProject || registeredProject.is_synthetic || registeredProject.root_path.trim().length === 0) {
    throw new Error(
      `Real project ${projectAuthority.primary.project_id} not found`,
    );
  }
  if (
    session.worktree_path
    && session.project_id !== projectAuthority.primary.project_id
  ) {
    // A worktree is derived from the project that owned the session when it
    // was created. If a global session fell over to another current link,
    // that persisted path cannot carry the removed project's authority with
    // it. Clear it before any cwd/tool setup (and before optional new-worktree
    // creation for the replacement primary).
    await store.setSessionWorktree(session.id, null);
    session = { ...session, worktree_path: null };
  }
  const originalProjectRoot = registeredProject.root_path;
  const sessionWorkspaceRoot = await resolveSessionWorkspaceRoot(originalProjectRoot, session);
  const project = { ...registeredProject, root_path: sessionWorkspaceRoot };
  const unionProjectLinks = session.is_global
    ? projectAuthority.projects.map((linked) => ({
        project_id: linked.project_id,
        name: linked.name,
        root_path: linked.root_path,
        is_primary: linked.is_primary,
      }))
    : [];
  const unionWorkspaceProjects = assignWorkspaceSlugs(unionProjectLinks);

  // Memory READ scope. A global session reads every linked real project
  // (primary first) so the agent sees each project's learnings.
  // For an ordinary project this resolves to `[the project]`, so every memory
  // consumer below stays single-iteration and byte-equivalent to before.
  const allReadProjects: ReadProject[] = session.is_global
    ? (() => {
        return unionProjectLinks.length
          ? unionProjectLinks.map((l) => ({ id: l.project_id, name: l.name }))
          : [{ id: project.id, name: project.name }];
      })()
    : [{ id: project.id, name: project.name }];
  // Honour each project's memory toggle (mig 115): read only from enabled
  // members. Empty → the session has no memory and every gate below falls to
  // `undefined` — exactly as a single disabled project did before.
  const memoryReadProjects = allReadProjects.filter((p) => db.getProjectMemoryEnabled(p.id));
  const anyMemoryEnabled = memoryReadProjects.length > 0;
  // Durable writes land on the primary real project. Gate compaction harvest
  // on that project's toggle so a disabled primary is never written through a
  // global session.
  const memoryWriteProjectId = project.id;

  // Global sessions run from the primary real root and carry explicit
  // secondary roots. No synthetic project or junction directory participates.
  const linkedSecondaryProjects: {
    id: number;
    name: string;
    rootPath: string;
  }[] = unionWorkspaceProjects
    .filter((linked) => linked.project_id !== project.id)
    .map((linked) => ({
      id: linked.project_id,
      name: linked.name,
      rootPath: linked.root_path,
    }));

  // Deterministic project→slug shared by every prefixed-tool path AND the
  // multi-root fs resolver. The tool array is a prompt-cache prefix, so this
  // MUST be stable for a given project name.
  const projectSlug = (name: string): string =>
    name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();

  // Per-secondary-root overlays (reused by the read bridges below AND the write
  // path) + the resolved root descriptors handed to the fs tools' multi-root
  // resolver and the snapshot recorder. Empty for normal / company sessions, so
  // every downstream consumer that branches on these stays inert for them.
  const secondaryOverlays = new Map<number, SessionOverlay>();
  const secondaryRoots = linkedSecondaryProjects.map((p) => {
    const rootPath = resolvePath(p.rootPath);
    const ov = new SessionOverlay(rootPath);
    secondaryOverlays.set(p.id, ov);
    return { projectId: p.id, name: p.name, slug: projectSlug(p.name), rootPath };
  });

  // For google-oauth sessions, ensure a persistent CloudCode session ID exists.
  let cloudCodeSessionId: string | undefined;
  if (session.provider === 'google-oauth') {
    cloudCodeSessionId = await store.getOrCreateCloudCodeSessionId(session.id);
  }

  // Provider — async path so Copilot tokens get refreshed before the run.
  const provider = await createCoderProvider(
    session.provider,
    session.model,
    cloudCodeSessionId ? { cloudCodeSessionId } : undefined,
  );

  // Session overlay — tracks files touched this run so MCP read tools
  // serve fresh disk data without re-indexing.
  const overlay = new SessionOverlay(resolvePath(project.root_path));
  // Side-file store for truncated tool outputs — enables `get_tool_output`.
  const toolOutputStore = new BundleToolOutputStore(store, session.id);

  // Tool registry: native tools + bridged MCP tools
  const registry = new ToolRegistry();
  registry.registerAll(chatCollaborationTools);
  if (!opts.companyContext) registry.registerAll(sessionNetworkTools);
  if (!opts.companyContext) registry.registerAll(ultraFollowupTools);
  registry.registerAll(chatChangesTools);
  // Mutable by design: code_exec/find_tools capture this map before external
  // MCP and plugin tools are registered, then observe the completed catalog
  // at invocation time.
  const runtimeToolTiers = new Map<string, ToolTier>();
  const registerCompanyTools = (tools: readonly CoderTool[]): void => {
    registry.registerAll(withCompanyToolsMetadata(tools));
  };
  const appCompanyCapabilities = opts.companyContext?.capabilities;
  const isAppStudioCompany = opts.companyContext != null
    && (appCompanyCapabilities?.runtimeKind === 'app_studio'
      || opts.companyContext.runtimeKind === 'app_studio');
  const allowCompanyKanban = appCompanyCapabilities?.allowCompanyKanban ?? !isAppStudioCompany;
  const normalizedCompanyRole = opts.companyContext?.agentRole.trim().toLowerCase() ?? '';
  const hasGenericQaCapability = opts.companyContext != null
    && !opts.companyContext.isMaster
    && !isAppStudioCompany
    && (
      normalizedCompanyRole === 'qa'
      || (() => {
        try {
          return roleHasQaPlaywrightSkill(
            opts.companyContext!.orchestrator.getSessionConfigJson(),
            opts.companyContext!.agentRole,
          );
        } catch {
          return false;
        }
      })()
    );
  registry.registerAll(fsTools);
  registry.registerAll(shellTools);
  // The primary root is a real repository, so ordinary Git tools remain valid.
  // Linked repositories are addressed through scoped shell cwd values.
  registry.registerAll(gitToolsForProject());
  // apply_patch is registered for ALL providers. For ChatGPT/Codex with
  // `apply_patch_tool_type === 'freeform'`, the chatgpt provider rewrites
  // the wire shape to `type: 'custom'` (raw patch text, no JSON escaping).
  // For everyone else (Claude, Gemini, etc.) it stays a regular function
  // tool with a single `patch: string` param — the model emits JSON-
  // escaped patch text and the handler parses it. Costs ~600 extra chars
  // in the system prompt vs gating, but pays off on multi-file edits where
  // a single deterministic patch beats N rounds of edit_file.
  registry.register(applyPatchTool);

  // Company subordinates get master-directed communication tools instead of
  // the human-facing ask_user / submit_plan / task_list approval. The replacement
  // tools emit the same runner events so orchestrator interception is unchanged.
  if (opts.companyContext && !opts.companyContext.isMaster) {
    registerCompanyTools(buildSubordinateTools());
    registry.register(listTasks);
    registry.register(cancelTasks);
    registry.register(deleteTasks);
    registry.register(archiveTaskList);
    // Frente D — drop `execute_task` (singular). The orchestrator
    // `execute_tasks` (plural) covers every dispatch path; the model has
    // no remaining reason to call the per-task entry point.
    registry.register(taskComplete);
    registry.register(updateTask);
  } else {
    registry.registerAll(planTools);
    registry.registerAll(specTools);
    registry.registerAll(tasksTools);
    registry.registerAll(interactionTools);
  }
  // Env tools manage session-shared env vars stored in the DB
  // (`company_session_envs`). They work with NO container alive, so they are
  // registered for EVERY company session — master + subordinates — not just
  // builder/sandbox ones. A session can define shared envs (BACKEND_URL,
  // JWT_TOKEN, …) while targeting an EXTERNAL backend with no container;
  // gating these behind the sandbox binding hid them from `find_tools`, so
  // the master had to relay env values to subordinates by hand. The master
  // filter (`filterInPlace(isMasterAllowed)` below) trims the master to the
  // read-only trio (env_list/env_read/env_validate); subordinates keep all 5.
  if (opts.companyContext) {
    registerCompanyTools(envTools);
    registerCompanyTools(docsTools);
  }
  // Sandbox-bound tools: offered to agents whose company session has a
  // live container binding (service-bound subordinates). Tools that
  // actually need a live container (sandboxTools, docsTools) fail with
  // clear errors when called while it is down.
  if (opts.companyContext?.sandbox) {
    registerCompanyTools(sandboxTools);
    // service_* tools (B5): structured log history + container lifecycle
    // control. Same STABLE per-profile gate as sandboxTools (nothing
    // per-request); authorization (master / own-service / devops skill)
    // is enforced inside each handler.
    registerCompanyTools(serviceTools);

  }
  // expand_toolset registered AFTER external MCP servers (see below) so its
  // tier enum can include custom tiers dynamically.
  registry.registerAll(toolOutputTools);
  registry.registerAll(diagnosticsTools);
  registry.registerAll(lspTools);
  registry.registerAll(execCommandTools);
  registry.registerAll(webTools);
  registry.registerAll(httpTools);
  // API client (auto-test/auto-fix) tools — gated to the `api` tool tier, so
  // they only surface for the `api` agent (or after expand_toolset('api')).
  // They read ctx.projectId + the module-global ApiClientStore.
  registry.registerAll(apiClientTools);
  // db_* tools (Databases-tab connections, v2) — registered UNCONDITIONALLY
  // for single AND company sessions (the tool array is an LLM cache prefix;
  // never gate registration on config/request). Surface is gated by the `db`
  // tool tier; the master filter trims db_command afterwards.
  registry.registerAll(dbTools);
  // draw.io diagram tools — gated to the `diagram` tool tier, so they only
  // surface for the `diagram` agent (or after expand_toolset('diagram')).
  // Stateless: each reads ctx.cwd and writes .drawio via the fs port.
  registry.registerAll(diagramTools);
  registry.registerAll(globTools);
  registry.registerAll(ragSearchDocsTools);
  registry.registerAll(ragReadDocTools);
  registry.registerAll(ragDocOutlineTools);
  registry.registerAll(viewImageTools);
  registry.registerAll(previewTools);
  registry.registerAll(browserTools);
  // Session Drive — single-session working memory (read_plan / remember /
  // list_memory / recall_investigations). Only outside company context:
  // company sessions have the shared drive + board instead, and the tools
  // need `ctx.sessionDrive` which is wired below for real (non-company)
  // sessions. Bootstrap-tier (see tools/tiers.ts) so any mode can use them.
  if (!opts.companyContext) {
    registry.registerAll(buildSessionDriveTools());
  }
  // Append-only compaction history. Registered for every persisted coder
  // session; the store-backed port is session-scoped and cannot cross-read.
  registry.registerAll(buildConversationChapterTools());
  // Project memory read tool (recall_memory) — any session whose host wired
  // the `projectMemory` ports (single sessions today; company keeps the
  // mcp__search_memory path). The per-project memory_enabled gate is applied
  // at the ToolContext wiring, so an absent port degrades to a clear message.
  if (opts.projectMemory) {
    registry.registerAll(buildProjectMemoryTools());
  }
  // Cross-agent comm tools (list_agents / wait_agents / send_message /
  // send_input / followup_task) were registered here UNCONDITIONALLY, so they
  // fell through getToolTier → bootstrap and shipped on turn 1 of every SOLO
  // session — where each errors or returns just-self (no peer to reach). Moved
  // into the `if (opts.companyContext)` block below (P1) so solo prompts drop
  // them entirely. Master/subordinate sessions are unaffected.
  // code_exec — registered last in the native batch so its tools-proxy
  // closes over a registry that already includes fs/git/web/lsp/glob/etc.
  // The proxy itself is rebuilt per invocation (`registry.list()` at call
  // time), so MCP/company tools added later are also picked up.
  registry.register(buildCodeExecTool(registry, runtimeToolTiers));
  registry.registerAll(worktreeTools);

  // MCP bridges — Master gets N bridges (one per company project, prefixed tools),
  // subordinates and regular sessions get a single bridge. A GLOBAL session gets
  // the regular single bridge for its PRIMARY project PLUS one prefixed bridge
  // per linked secondary project (the block after the if/else below). `projectSlug`
  // and `secondaryOverlays` are built in Seam A above.
  const bridge = new McpToolBridge({ deferConnection: true });
  const extraBridges: McpToolBridge[] = [];
  let mcpBridgeOk = false;

  if (opts.companyContext?.isMaster) {
    // Master: register prefixed MCP tools for ALL company projects
    const companyProjects = opts.companyContext.orchestrator.listProjects();
    for (const proj of companyProjects) {
      const projBridge = new McpToolBridge({ deferConnection: true });
      try {
        const slug = projectSlug(proj.name);
        const projOverlay = new SessionOverlay(resolvePath(proj.rootPath));
        const mcpTools = await projBridge.listTools({
          projectName: proj.name,
          projectRoot: proj.rootPath,
          overlay: projOverlay,
        });
        // Rename mcp__read_file → mcp__{slug}__read_file, without agent-run control.
        const prefixed = prefixedBridgeTools(mcpTools, slug);
        registry.registerAll(prefixed);
        extraBridges.push(projBridge);
        console.log(`[coder] Master: ${prefixed.length} MCP tools for project ${proj.name} (prefix: mcp__${slug}__*)`);
      } catch (e) {
        console.warn(`[coder] MCP bridge for ${proj.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        await projBridge.close();
      }
    }
    mcpBridgeOk = extraBridges.length > 0;
  } else {
    // Regular session / subordinate: single bridge
    try {
      const mcpTools = await bridge.listTools({
        projectName: project.name,
        projectRoot: project.root_path,
        overlay,
      });
      // Agent-run control never reaches the agent (internal-mcp-exposure.ts).
      // Twins of native tools (read/list/doc) are pruned after the filters below.
      registry.registerAll(primaryBridgeTools(mcpTools));
      // Resource discovery/read tools — companion to the bridged tools.
      // Cheap to expose: handlers no-op when the server publishes nothing.
      registry.registerAll(buildMcpResourceTools(bridge));
      mcpBridgeOk = mcpTools.length > 0;
    } catch (e) {
      console.warn(`[coder] MCP bridge failed to connect: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Global (multi-project) session: ALSO expose each linked SECONDARY project as
  // prefixed `mcp__<slug>__*` read tools, on top of the primary's native bridge
  // above. `linkedSecondaryProjects` is empty for normal sessions and company
  // runs, so this loop never executes for them (the regular path is unchanged).
  // Reuses the exact master prefixing so the model's cross-project tool
  // vocabulary (`mcp__<slug>__read_file`, etc.) is identical in both modes.
  for (const proj of linkedSecondaryProjects) {
    const projBridge = new McpToolBridge({ deferConnection: true });
    try {
      const slug = projectSlug(proj.name);
      // Reuse the same overlay the write path uses for this root, so a write
      // and a subsequent MCP read in this project see consistent fresh content.
      const projOverlay = secondaryOverlays.get(proj.id) ?? new SessionOverlay(resolvePath(proj.rootPath));
      const mcpTools = await projBridge.listTools({
        projectName: proj.name,
        projectRoot: proj.rootPath,
        overlay: projOverlay,
      });
      // Prefixed: no agent-run control (internal-mcp-exposure.ts).
      const prefixed = prefixedBridgeTools(mcpTools, slug);
      registry.registerAll(prefixed);
      extraBridges.push(projBridge);
      console.log(`[coder] Global session: ${prefixed.length} MCP tools for project ${proj.name} (prefix: mcp__${slug}__*)`);
    } catch (e) {
      console.warn(`[coder] MCP bridge for ${proj.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      await projBridge.close();
    }
  }

  // External MCP servers — configured via admin panel (migration 015).
  // Connected AFTER internal bridge so external tools are at the tail of the
  // registry, meaning they are trimmed first when the model tool cap kicks in.
  //
  // Prefer the caller-provided manager (typically the http-api's pool-backed
  // `RemoteMcpServerManager`) so we don't reopen transports per run. Fall back
  // to a local `McpServerManager` for CLI / test usage where there's no pool.
  const mcpServerManager: import('@mcp/code-agent/tools/mcp-server-manager-interface.js').IMcpServerManager =
    opts.externalMcpManager ?? new McpServerManager(opts.mcpBearerResolver ?? null);
  // Subordinate-only override: turns each connected MCP server into its own
  // custom tier (named by server id) so the agent sees the pack in the
  // system prompt and reaches it through find_tools + code_exec, instead of
  // the admin's `default_tier` deciding visibility per-server.
  let subordinateTierSummary: Map<string, { displayName: string; toolCount: number }> | undefined;
  const isSubordinate = !!opts.companyContext && !opts.companyContext.isMaster;
  const exactAllowedToolNames = opts.allowedToolNames === undefined
    ? null
    : new Set(opts.allowedToolNames);
  const loadExternalToolCatalogAtLaunch = async (): Promise<number> => {
    const mcpServerStore = new McpServerStore(config.dbPath);
    try {
      const enabledServers = mcpServerStore.listServers({ enabled: true });
      await mcpServerManager.connectAll(enabledServers);

      const { tools: extTools, tierMap } = await mcpServerManager.listAllTools();
      const newTools = extTools.filter((tool) => !registry.has(tool.name));
      if (newTools.length > 0) registry.registerAll(newTools);

      if (isSubordinate) {
        const summary = new Map<string, { displayName: string; toolCount: number }>();
        for (const server of enabledServers) {
          const prefix = `ext_${server.id}__`;
          const serverToolNames = extTools
            .filter((tool) => tool.name.startsWith(prefix) && registry.has(tool.name))
            .map((tool) => tool.name);
          if (serverToolNames.length === 0) continue;
          for (const name of serverToolNames) runtimeToolTiers.set(name, server.id);
          summary.set(server.id, { displayName: server.name, toolCount: serverToolNames.length });
        }
        subordinateTierSummary = summary;
      } else {
        for (const [name, tier] of tierMap) {
          if (registry.has(name)) runtimeToolTiers.set(name, tier);
        }
      }

      // Cache discovered tools in DB so admin/session panels see them instantly.
      for (const server of enabledServers) {
        const prefix = `ext_${server.id}__`;
        const serverTools = extTools
          .filter((tool) => tool.name.startsWith(prefix))
          .map((tool) => ({ name: tool.name.slice(prefix.length), description: tool.description }));
        if (serverTools.length > 0) mcpServerStore.replaceServerTools(server.id, serverTools);
      }

      if (extTools.length > 0) {
        console.log(
          `[coder] ${extTools.length} external tool(s) from ${mcpServerManager.connectedCount} MCP server(s)` +
            '; attempt catalog snapshot pending seal',
        );
      }
      return newTools.length;
    } finally {
      mcpServerStore.close();
    }
  };

  try {
    await loadExternalToolCatalogAtLaunch();
    if (isSubordinate && subordinateTierSummary && subordinateTierSummary.size > 0) {
      console.log(
        `[coder] subordinate ${opts.companyContext!.agentRole}: external MCPs as opt-in tiers ` +
          `[${[...subordinateTierSummary.keys()].join(', ')}] — reachable through find_tools`,
      );
    }
  } catch (e) {
    console.warn(`[coder] External MCP servers failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Plugin tools — contributed by installed plugins, with worker-backed
  // handlers synthesized by the http-api layer (@mcp/plugin-host
  // buildPluginTools). Each plugin declares its own opt-in runtime tier, so
  // none of these tools leak through getToolTier's bootstrap fallback.
  let pluginTierSummary = new Map<string, { displayName: string; toolCount: number }>();
  if (opts.hostTools?.length) registry.registerAll(opts.hostTools);
  if (opts.pluginTools?.length) {
    registry.registerAll(opts.pluginTools);
    const pluginTiers = collectRuntimeToolTiers(opts.pluginTools);
    for (const [name, tier] of pluginTiers.tierMap) runtimeToolTiers.set(name, tier);
    pluginTierSummary = pluginTiers.summary;
  }

  // Opt-in tool groups listed in the system prompt (find_tools reaches them).
  // For subordinates, every enabled MCP server is its own group (regardless of
  // the admin's `default_tier`) so the master/session-free behavior is preserved.
  const customTierSummary = mergeRuntimeTierSummaries(
    subordinateTierSummary ?? mcpServerManager.getCustomTierSummary(),
    pluginTierSummary,
  );
  // find_tools — Camada 3 lazy discovery. Always registered (cheap, read-only,
  // no tier promotion). Belongs in bootstrap so it's visible before the agent
  // has unlocked anything else. Implementation lives in find-tools.ts.
  registry.registerAll([buildFindToolsTool(
    registry,
    runtimeToolTiers,
  )]);

  // request_review — Camada 4 reviewer subagent. It reads the same child tool
  // snapshot the subagents get (taken below, after the custom allowlist, the
  // research preset, the disabled lists and the twin pass), resolved at review
  // time. The reviewerProvider falls back to the parent provider when
  // subagentTarget hasn't been configured (legacy single-family behaviour).
  let childToolSnapshot: CoderTool[] = [];
  if (!isAppStudioCompany) {
    registry.registerAll([
      buildRequestReviewTool({
        provider,
        parentTools: () => childToolSnapshot,
        sessionId: session.id,
        sessionStore: store,
        resolveReviewerProvider: async () => subagentDeps ? providerForProfile(subagentDeps, 'review') : undefined,
      }),
    ]);
  }

  // Custom agents can opt into an exact tool surface. Apply this after every
  // native/MCP/plugin tool has registered and before subagent snapshots are
  // captured, so the allowlist is an execution boundary rather than a UI-only
  // hint. `undefined` means inherit; `[]` intentionally removes every tool.
  if (exactAllowedToolNames !== null) {
    registry.filterInPlace((tool) => exactAllowedToolNames.has(tool.name));
  }
  if (effectiveAgentId === 'research') {
    registry.filterInPlace(isResearchToolAllowed);
  }

  // Load disabled tools early so the subagent parentTools snapshot is already
  // filtered. Must happen before registry.list() is captured below.
  let globalDisabledTools: ReadonlySet<string> | undefined;
  try {
    const ps = new ProviderStore(config.dbPath);
    const disabled = ps.listGlobalDisabledTools();
    ps.close();
    const policyDisabled = opts.runtimePolicy?.capabilities.disabledCapabilityNames ?? [];
    const combinedDisabled = [...disabled, ...policyDisabled];
    if (combinedDisabled.length > 0) globalDisabledTools = new Set(combinedDisabled);
  } catch {
    /* table may not exist yet — no-op */
  }
  const sessionDisabledTools = await store.getSessionDisabledTools(session.id);
  // Do not advertise a cross-session recall path that is guaranteed to fail.
  // The control arm of the live memory benchmark showed models spending calls
  // retrying recall_memory when the project toggle was off.
  if (!opts.projectMemory) sessionDisabledTools.add('recall_memory');

  // One read, list and doc-read name on the primary project: drop each MCP
  // twin (mcp__read_file, mcp__list_directory, mcp__rag_*) only while its
  // native tool survived the custom-agent allowlist and research filter above
  // and is not disabled globally or for this session; otherwise the twin is
  // the working route and stays. Before the subagent snapshot below.
  pruneRedundantPrimaryTwins(registry, {
    has: (name) => !!globalDisabledTools?.has(name) || sessionDisabledTools.has(name),
  }, getGlobalDocSearch());
  // What every child agent (subagents, the request_review reviewer) may draw
  // from: the final registry minus the disabled tools.
  const childDisabled = new Set([...(globalDisabledTools ?? []), ...sessionDisabledTools]);
  childToolSnapshot = childDisabled.size > 0
    ? registry.list().filter((t) => !childDisabled.has(t.name))
    : registry.list();

  // Subagent deps — built AFTER MCP tools so it captures the full tool list
  // for filtering. Disabled via CODER_DISABLE_SUBAGENTS=1. Also DISABLED for
  // company Master (it must use spawn_subordinate_agent instead — ephemeral
  // subagents don't fit the orchestration role).
  const policyFiles = new CollaborationFiles(joinPath(store.locator.dataDir, 'chat-collaboration'));
  await policyFiles.init();
  const savedUltraSettings = await new CollaborationRevisions(policyFiles).read<{ maxParallel?: number; maxStarts?: number }>('policies', `${session.id}:settings`);
  const ultraPreset = resolveUltraPreset({
    enabled: ultraExecutionEnabled, effort: effectiveReasoningEffort,
    supportedEfforts: provider.reasoningCapabilities?.canReason === false ? []
      : provider.reasoningCapabilities?.supportedLevels ?? undefined,
    canDelegate: opts.runtimePolicy?.subagents.enabled,
    maxParallel: Math.min(opts.runtimePolicy?.subagents.maxParallel ?? Infinity, savedUltraSettings?.value.maxParallel ?? (ultraExecutionEnabled ? 3 : 4)),
    // Read-only agents (AgentDefinition.readOnly) plus Plan, whose plan gate
    // keeps it read-only until approval; neither may get writing children.
    readOnly: agentDef?.readOnly === true || effectiveAgentId === 'plan',
  });
  let subagentDeps: SubagentDeps | null = null;
  if (shouldEnableEphemeralSubagents(
    opts.companyContext,
    opts.runtimePolicy ? !opts.runtimePolicy.subagents.enabled : false,
  )) {
    const parentTools = childToolSnapshot;
    let resolveProviderForProfile:
      | ((id?: string) => Promise<ChatProvider | undefined>)
      | undefined;
    let resolveEffortForProfile: ((id?: string) => string | undefined) | undefined;
    let resolveLimitsForProfile: ((id?: string) => ProfileLimitOverride | undefined) | undefined;
    try {
      const ps = new ProviderStore(config.dbPath);
      const defaultTarget = ps.getSubagentTarget(session.provider);
      const defaultEffort = ps.getSubagentEffort(session.provider);
      // Snapshot per-profile targets + efforts (already default-merged by the
      // store) so the resolver never re-touches the DB after the runner build.
      const profileTargets = new Map<MicroAgentProfileId, SubagentTarget | null>();
      const profileEfforts = new Map<MicroAgentProfileId, string | null>();
      const profileLimits = new Map<MicroAgentProfileId, ProfileLimitOverride | null>();
      for (const id of SUBAGENT_PROFILE_IDS) {
        profileTargets.set(id, ps.getSubagentProfileTarget(session.provider, id));
        profileEfforts.set(id, ps.getSubagentProfileEffort(session.provider, id));
        profileLimits.set(id, ps.getSubagentProfileLimits(session.provider, id));
      }
      ps.close();

      // Default and per-profile providers are lazy + memoized. Sessions that
      // never delegate do not pay for an unused second provider at startup.
      const resolver = createSubagentProviderResolver({
        sessionProvider: session.provider,
        sessionModel: session.model,
        defaultTarget: defaultTarget ?? null,
        profileTargets,
        defaultEffort,
        profileEfforts,
        profileLimits,
        createProvider: createCoderProvider,
      });
      resolveProviderForProfile = (id) => resolver.forProfile(id);
      resolveEffortForProfile = (id) => resolveSubagentExecutionEffort(
        ultraExecutionEnabled,
        resolver.effortFor(id),
      );
      resolveLimitsForProfile = (id) => resolver.limitsFor(id);
    } catch { /* non-fatal — falls back to parent provider */ }

    subagentDeps = {
      provider,
      parentTools,
      sessionStore: store,
      resolveProviderForProfile,
      resolveEffortForProfile,
      resolveLimitsForProfile,
      externalToolTiers: runtimeToolTiers,
      maxParallel: ultraPreset.effective.parallelism.maxAgents,
    };
  }

  // Company tools — registered when this runner is part of a company session.
  if (opts.companyContext) {
    const { orchestrator, agentRole, isMaster, agentRunId } = opts.companyContext;
    const boardTools = buildBoardTools(orchestrator, agentRole, agentRunId);
    registerCompanyTools(allowCompanyKanban
      ? boardTools
      : boardTools.filter((tool) => !tool.name.startsWith('kanban_')));
    // Shared drive: persistent file pool scoped to the company template,
    // visible to master and every subordinate. Lets agents exchange large
    // documents without inflating board posts or inbox messages.
    registerCompanyTools(buildSharedDriveTools());
    // Cross-agent comm tools — available to master AND subordinates. Moved
    // here from the unconditional native batch (P1): each errors or returns
    // just-self without a company session, so registering them in solo
    // sessions only bloated the prompt with peers that can't be reached.
    registry.registerAll(listAgentsTools);
    registry.registerAll(waitAgentsTools);
    registry.registerAll(sendMessageTools);
    registry.registerAll(sendInputTools);
    registry.registerAll(followupTaskTools);
    // Subordinate kanban tools: self-service card updates (comment, checklist, move-to-review)
    if (!isMaster && agentRunId != null) {
      if (allowCompanyKanban) {
        registerCompanyTools(buildSubordinateKanbanTools(orchestrator, agentRole, agentRunId));
      }
      // Generic QA tools synchronize results into Company Kanban. Register
      // them only for the role that owns the QA capability; other roles no
      // longer carry a dormant QA surface in their registry. App teams use
      // app_run_checks + app_record_work_evidence instead.
      if (hasGenericQaCapability) {
        registerCompanyTools(buildQaTools(orchestrator, agentRole, agentRunId));
      }
    }
    if (isMaster) {
      // review_subordinate_work needs in-process DB access to run the review
      // pipeline over a subordinate's snapshots — supply the shared handle and
      // a project-root resolver (same db/store already in scope here).
      registerCompanyTools(
        buildMasterTools(orchestrator, {
          settingsDbHandle: db.raw(),
          sessionStore: store,
          getProjectRoot: (projectId: number) => db.getProject(projectId)?.root_path ?? null,
        }),
      );
      if (allowCompanyKanban) registerCompanyTools(buildKanbanTools(orchestrator));
      // Strip code-level tools from Master — it should only orchestrate, not read code
      registry.filterInPlace((tool) => isMasterAllowed(tool));
      console.log(`[coder] Master: filtered to ${registry.list().length} tools (orchestration-only)`);
    }
  }

  // Unified spawn tool — single entry point replacing the deprecated
  // spawn_subagent/spawn_agents pair. Schema accepts an `agents` array
  // (1 item → sequential, N → parallel, up to 8). Persistent kind delegates
  // to spawn_subordinate_agent when in a Company master session.
  if (subagentDeps || registry.get('spawn_subordinate_agent')) {
    // Either subagent deps exist (ephemeral path) OR master has the
    // subordinate path; in the latter we still register so the model has
    // a single dispatcher even without ephemeral capability.
    const fallbackDeps: SubagentDeps =
      subagentDeps
      ?? { provider, parentTools: [], sessionStore: store };
    registry.register(buildSpawnAgentTool(fallbackDeps, registry));
  }

  // resume_agent + collect_agents — the async companions of spawn_agent
  // (relaunch failed ephemeral subagents; wait on/fetch background jobs).
  // Ephemeral capability only (company masters have resume_subordinate).
  if (subagentDeps) {
    const [{ buildResumeAgentTool }, { buildCollectAgentsTool }, { buildReadAgentTranscriptTool }] = await Promise.all([
      import('@mcp/code-agent/tools/resume-agent.js'),
      import('@mcp/code-agent/tools/collect-agents.js'),
      import('@mcp/code-agent/tools/read-agent-transcript.js'),
    ]);
    registry.register(buildResumeAgentTool(subagentDeps));
    registry.register(buildResumeChatTool(subagentDeps));
    registry.register(buildCollectAgentsTool(subagentDeps));
    // P1 (ultra-agent parity): read-only audit of a finished subagent's
    // retained transcript — the observability half of spawn_agent.
    registry.register(buildReadAgentTranscriptTool(store));
  }

  // workflow — Ultra's standing declarative DAG orchestrator (P0 of the
  // ultra-agent parity plan). Registered ONLY when this run executes with
  // the Ultra posture (sticky mode or `ultracode` turn keyword) so Ultra
  // visibly unlocks a capability; registration is per-run, so the tool
  // array stays byte-stable while the mode is stable.
  if (subagentDeps && ultraExecutionEnabled) {
    const { buildWorkflowTool } = await import('@mcp/code-agent/tools/workflow/workflow-tool.js');
    registry.register(buildWorkflowTool(subagentDeps));
  }

  // execute_tasks — wave-based orchestrator (PR 3). Needs subagentDeps to
  // exist; only registers when the session has the subagent capability
  // (i.e. NOT a Company master, NOT CODER_DISABLE_SUBAGENTS=1), and only
  // where a human can approve a task list: task_list({gate:'approve'}) is
  // registered (Company subordinates use submit_tasks_to_master instead).
  if (subagentDeps && registry.get('task_list')) {
    const { buildExecuteTasksTool } = await import('@mcp/code-agent/tools/execute-tasks.js');
    registry.register(buildExecuteTasksTool(subagentDeps));
  }

  // Builder mode: when the company context carries a sandbox binding,
  // we pin `cwd` to the container workdir and swap the default ports
  // for sandbox-backed adapters. Every filesystem/shell tool from here
  // on transparently talks to the container — no conditional in the
  // tool code. The host `project.root_path` is ignored because there
  // is no host-side project in builder mode (yet).
  const sandboxBinding = opts.sandbox ?? opts.companyContext?.sandbox;
  // Defense-in-depth: if this is a builder-mode session (project sits
  // under `data/virtual-projects/`) but the companyContext has no
  // sandbox binding, something dropped it between orchestrator and
  // runCoder. The fallback below will use LocalFilesystemAdapter and
  // writes will silently land on the host — exactly the resume-path
  // bug we chased. Emit a loud warning so future regressions are
  // caught on the first run instead of via user screenshots.
  if (
    opts.companyContext &&
    !sandboxBinding &&
    project.root_path.replace(/\\/g, '/').includes('/data/virtual-projects/')
  ) {
    console.warn(
      `[coder] SUSPICIOUS: builder-mode session (project="${project.name}") but ` +
        `companyContext.sandbox is undefined — writes will land on the host at ` +
        `${project.root_path} instead of the sandbox container. This is almost ` +
        `certainly a missing binding-propagation in the orchestrator.`,
    );
  }
  const workspace: WorkspaceContext = workspaceFromProject(project, sandboxBinding);
  const effectiveCwd = workspace.rootPath;
  // External host roots are a local-session capability. A container-bound run
  // cannot safely translate host paths into its filesystem namespace. Company
  // agents also run without an interactive session owner, so keep grants scoped
  // to ordinary local coder sessions.
  const allowExternalFilesystemRoots = !sandboxBinding && !opts.companyContext;
  const externalRoots: Array<{
    id: string;
    seq: number;
    rootPath: string;
    access: 'read' | 'write';
  }> = !allowExternalFilesystemRoots
    ? []
    : (await store.listSessionFilesystemRoots(session.id))
        .filter((root) => existsSync(root.root_path))
        .map((root) => ({
          id: root.id,
          seq: root.seq,
          rootPath: root.root_path,
          access: root.access,
        }));
  // Snapshot rows already key files by project_id. Negative ids form a
  // collision-free namespace for session filesystem-root ids without
  // pretending those folders are indexed projects.
  const snapshotRoots = [
    ...secondaryRoots.map((root) => ({ projectId: root.projectId, rootPath: root.rootPath })),
    ...externalRoots
      .filter((root) => root.access === 'write')
      .map((root) => ({ projectId: -root.seq, rootPath: root.rootPath })),
  ];
  const authorizeFilesystemRoot = !allowExternalFilesystemRoots
    ? undefined
    : async (rawPath: string, access: 'read' | 'write') => {
        const canonical = canonicalizeExternalRoot(rawPath);
        if (!canonical.ok) throw new Error(canonical.reason);
        const knownProjectRoots = [workspace.rootPath, ...secondaryRoots.map((root) => root.rootPath)];
        const insideProject = knownProjectRoots.some((root) => {
          const rel = relativePath(root, canonical.path);
          return rel === '' || (!rel.startsWith('..') && !isAbsolutePath(rel));
        });
        if (insideProject) throw new Error('directory is already inside an authorized project root');

        const persisted = await store.listSessionFilesystemRoots(session.id);
        const exact = persisted.find((root) => root.root_path.toLowerCase() === canonical.path.toLowerCase());
        if (!exact && persisted.length >= 16) throw new Error('session filesystem root limit reached (16)');
        const row = await store.upsertSessionFilesystemRoot(
          session.id,
          canonical.path,
          access,
        );
        const active = externalRoots.find((root) => root.id === row.id);
        if (active) {
          active.seq = row.seq;
          active.rootPath = row.root_path;
          active.access = row.access;
        } else {
          externalRoots.push({
            id: row.id,
            seq: row.seq,
            rootPath: row.root_path,
            access: row.access,
          });
        }
        if (
          row.access === 'write' &&
          !snapshotRoots.some((root) => root.projectId === -row.seq)
        ) {
          snapshotRoots.push({
            projectId: -row.seq,
            rootPath: row.root_path,
          });
        }
        return { rootPath: row.root_path, access: row.access };
      };
  const rawFsPort = sandboxBinding
    ? new SandboxFilesystemAdapter({
        driver: sandboxBinding.driver,
        containerId: sandboxBinding.containerId,
      })
    : defaultLocalFilesystemPort();
  const shellPort = sandboxBinding
    ? new SandboxShellAdapter({
        driver: sandboxBinding.driver,
        containerId: sandboxBinding.containerId,
        defaultCwd: sandboxBinding.workdir,
      })
    : defaultLocalShellPort();

  // Per-session file-snapshot recorder: every write/unlink that the agent
  // performs is captured (baseline + edit-log row) so the user can review
  // and selectively keep/undo via the Snapshots tab. Bypassed for the
  // company subordinate path? No — subordinates write under the parent's
  // ToolContext anyway, but here this runner is its own session and may
  // also be a parent. We always record; UI scopes by `session_kind` +
  // `session_id` from this exact `runCoder` call.
  const snapshotStore = store;
  // Always record under the runner's actual coder bundle — even inside Company
  // orchestration. The Company UI follows agent-run entity links to aggregate
  // master and subordinate snapshots without a cross-session SQL join.
  let runnerRef: import('@mcp/code-agent/core/runner.js').CoderRunner | null = null;
  const recorder = new SnapshotRecorder({
    sessionKind: 'coder',
    sessionId: session.id,
    projectRoot: workspace.rootPath,
    projectId: workspace.projectId,
    // Global session: writes under a linked secondary root are recorded against
    // that root's project (correct diff/revert target). Empty for normal sessions.
    secondaryRoots: snapshotRoots,
    store: snapshotStore,
    getTurn: () => runnerRef?.turn ?? null,
    getRoundMessageId: () => runnerRef?.roundMessageId ?? null,
    onRecorded: opts.onSnapshotRecorded,
  });
  const fsPort = new SnapshotRecordingFilesystemPort(rawFsPort, recorder);

  // self_review — runs the configured snapshot_review/reviewer pipeline over
  // THIS session's active snapshots so the agent can validate its own work
  // before claiming done. Registered after the subagent parentTools snapshot
  // above so ephemeral subagents don't inherit it. Always available (bootstrap
  // tier); the CODER_SELF_REVIEW toggle only governs the proactive reminder.
  registry.register(
    buildSelfReviewTool({
      settingsDbHandle: db.raw(),
      sessionStore: store,
      sessionId: session.id,
      projectRoot: workspace.rootPath,
      secondaryRoots: snapshotRoots,
      // Same-registry access so absence detection resolves references through
      // the project's mcp__find_references (registered above with MCP tools).
      registry,
      projectId: workspace.projectId,
    }),
  );

  // Auto-captured session notes — LLM-free hooks (plan approved, task closed, error-streak fixed) that keep the Session State
  // Block useful even when the model never calls save_note on its own.
  const autoCapture = buildAutoCapture({
    store,
    sessionId: session.id,
    enabled: !opts.companyContext,
    isRepeatable: (name) => {
      try { return registry.get(name)?.repeatable === true; } catch { return false; }
    },
  });
  let tasksStateCache = await store.getTasksState(session.id);
  let sessionStateDataCache = await store.getSessionStateData(session.id);
  let activePlanCache = sessionStateDataCache.activePlan;
  let flushChain: Promise<void> = Promise.resolve();
  let criticalTranscriptPersistenceError: Error | null = null;

  const collaboration = !opts.companyContext
    ? await createRootCollaboration(store.locator.dataDir, session.id, session.title || 'Chat')
    : undefined;
  const sessionNetwork = collaboration ? new SessionNetwork({ sessions: store, mailbox: collaboration.store,
    project: id => db.getProject(id),
    onChatCreated: opts.onChatCreated,
    validateModel: (providerId, modelId) => {
      const catalog = new ProviderStore(config.dbPath);
      try {
        if (!catalog.getProvider(providerId)?.enabled || !catalog.listModels(providerId, true).some(model => `${model.model_id}${model.mode ? `::${model.mode}` : ''}` === modelId)) throw new Error('Unknown or disabled provider/model');
      } finally { catalog.close(); }
    },
  }) : undefined;
  const budgetFiles = collaboration?.store.files ?? new CollaborationFiles(joinPath(store.locator.dataDir, 'chat-collaboration'));
  if (!collaboration) await budgetFiles.init();
  const budgetNetwork = sessionNetwork ? await sessionNetwork.config(session.id) : null;
  const budgetRoot = budgetNetwork && sessionNetwork ? await sessionNetwork.config(budgetNetwork.rootId) : null;
  const rootSettings = budgetRoot && budgetRoot.rootId !== session.id
    ? await new CollaborationRevisions(policyFiles).read<{ maxParallel?: number; maxStarts?: number }>('policies', `${budgetRoot.rootId}:settings`) : savedUltraSettings;
  const sharedBudget = ultraExecutionEnabled || budgetRoot?.enabled || opts.companyContext ? new CollaborationBudget(budgetFiles,
    `${opts.companyContext?.companySessionId ?? budgetRoot?.rootId ?? session.id}:${budgetRoot?.budgetId ?? 'initial'}:ultra`,
    { maxParallel: opts.companyContext ? (ultraExecutionEnabled ? 3 : 4) : rootSettings?.value.maxParallel ?? ultraPreset.effective.parallelism.maxAgents,
      maxStarts: rootSettings?.value.maxStarts ?? 24 }) : undefined;
  if (sharedBudget) {
    // Reapply a durable human setting after a crash between settings and ledger
    // publication. This changes limits only, never the consumed balance.
    if (rootSettings?.value.maxParallel !== undefined || rootSettings?.value.maxStarts !== undefined) await sharedBudget.configure({
      ...(rootSettings.value.maxParallel !== undefined ? { maxParallel: rootSettings.value.maxParallel } : {}),
      ...(rootSettings.value.maxStarts !== undefined ? { maxStarts: rootSettings.value.maxStarts } : {}),
    });
    await reconcileUltraBudget(sharedBudget, store);
  }
  const toolContext: ToolContext = {
    sessionNetwork,
    // What this session read/wrote whole survives across its runs (overwrite rule).
    fileKnowledge: sessionFileKnowledge(String(session.id)),
    agenticChat: budgetNetwork?.enabled === true && budgetRoot?.enabled === true,
    collaboration,
    ultraPolicy: ultraPreset,
    ultraBudget: sharedBudget ? new UltraAgentBudget(ultraPreset.effective.parallelism.maxAgents, 24, sharedBudget) : undefined,
    worktreeWorkspace: session.metadata?.worktree_workspace === true && !!session.worktree_path,
    cwd: effectiveCwd,
    projectName: workspace.displayName,
    globalWorkspace: session.is_global
      ? {
          sessionTitle: session.title,
          primaryRootPath: workspace.rootPath,
          projects: unionWorkspaceProjects.map((p) => ({
            projectId: p.project_id,
            name: p.name,
            slug: p.slug,
            rootPath: resolvePath(p.root_path),
            isPrimary: p.is_primary,
          })),
        }
      : undefined,
    // Global (multi-project) session: linked secondary roots the fs tools can
    // target via `project: "<slug>"`, plus their overlays. Undefined for normal
    // and company sessions, so the single-root path is unchanged for them.
    roots: secondaryRoots.length > 0 ? secondaryRoots : undefined,
    externalRoots,
    authorizeFilesystemRoot,
    overlayByRoot: secondaryOverlays.size > 0 ? secondaryOverlays : undefined,
    overlay,
    toolOutputStore,
    // Session-persistent stash for code_exec scripts (P1a pivot) — one per
    // session so content carried in `stash` survives across script calls.
    codeExecStash: createCodeExecStash(),
    // Interrogable diff (`change` global inside code_exec): read-only access
    // to this session's pending snapshot diffs. Built lazily per query so a
    // session that never calls `change.*` pays nothing.
    sessionChanges: {
      getDiffs: async () => {
        const service = new SessionSnapshotService(snapshotStore, (kind, sid, projectId) => {
          if (kind !== 'coder' || sid !== session.id) return null;
          if (projectId != null) {
            const sec = snapshotRoots.find((r) => r.projectId === projectId);
            if (sec) return sec.rootPath;
          }
          return workspace.rootPath;
        });
        const diffs = [];
        for (const baselineId of await snapshotStore.listActiveBaselineIds('coder', session.id)) {
          const diff = await service.getDiff(baselineId, { context: 3 });
          if (diff) diffs.push(diff);
        }
        return filterReviewableDiffs(diffs);
      },
      getBeforeContent: async (baselineId) => {
        const row = await snapshotStore.getBaselineById(baselineId);
        if (!row || row.session_kind !== 'coder' || row.session_id !== session.id) return null;
        // content_before is NULL for oversized/binary baselines even when the
        // file existed — report "unavailable" (null), never a fake empty file.
        if (!row.existed_before) return null;
        return row.content_before;
      },
    },
    toolOutputCapLevel:
      parseToolOutputCapLevel(session.tool_output_cap_level) ??
      levelFromLegacyBoolean(session.unrestricted_tool_output),
    signal: opts.signal,
    // Persistence hooks for submit_plan — let the dashboard list plans
    // long after the live tool_use scrolled out of view.
    getActivePlan: () => activePlanCache,
    recordPlan: async (toolUseId, planText) => {
      try {
        await store.recordPlan({
          session_id: session.id,
          tool_use_id: toolUseId,
          plan_text: planText,
        });
        activePlanCache = { text: planText, status: 'pending' };
      } catch (e) {
        console.warn(`[coder] recordPlan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    resolvePlan: async (toolUseId, status, feedback) => {
      try {
        await store.resolvePlan(session.id, toolUseId, status, feedback);
        const latestPlan = (await store.listPlans(session.id))[0] ?? null;
        activePlanCache = latestPlan
          ? { text: latestPlan.plan_text, status: latestPlan.status }
          : null;
        if (status === 'approved') {
          const captured = autoCapture.onPlanResolved(
            status,
            latestPlan?.plan_text ?? null,
            feedback,
          );
          if (captured) runnerRef?.requestMilestoneCompaction('milestone:plan-approved');
        }
      } catch (e) {
        console.warn(`[coder] resolvePlan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    setSessionAgent: async (agent) => {
      try {
        await store.setSessionAgent(session.id, agent);
      } catch (e) {
        if (agent === 'plan') throw e;
        console.warn(`[coder] setSessionAgent failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Apply the NEW agent's defaults to the LIVE runner so the next
      // mutating tool call in the same run unlocks immediately
      // (plan → build flow after `submit_plan` approval). Without this,
      // the runner kept the old `planMode=true` until the NEXT runCoder
      // invocation, so every edit between approval and the next user
      // message was refused by the plan-mode gate.
      //
      // Also emits `session_agent_changed` so the dashboard's AgentPicker
      // updates without a manual refetch (frontend listens on SSE).
      try {
        const live = runnerRef;
        if (live) {
          const def = AGENTS[agent];
          if (def) {
            // Apply the new agent's mode to the live runner so the next
            // mutating tool call unlocks/re-gates immediately (plan→build
            // after submit_plan approval). See CoderRunner.applyLiveAgent.
            live.applyLiveAgent(def, agent);
          }
          live.emit('session_agent_changed', { agent });
        }
      } catch (e) {
        console.warn(`[coder] setSessionAgent live-apply failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    // Tasks persistence — one independently-written task board per session.
    recordTasks: async (toolUseId, state) => {
      try {
        const row = await store.recordTasks({
          session_id: session.id,
          tool_use_id: toolUseId,
          state,
        });
        tasksStateCache = row.state;
      } catch (e) {
        console.warn(`[coder] recordTasks failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    resolveTasks: async (verdict) => {
      try {
        tasksStateCache = await store.resolveTasks(session.id, verdict);
      } catch (e) {
        console.warn(`[coder] resolveTasks failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    updateTaskStatus: async (taskId, patch) => {
      try {
        const row = await store.updateTaskStatus(session.id, taskId, patch);
        tasksStateCache = row;
        if (autoCapture.onTaskStatus(taskId, patch as Parameters<typeof autoCapture.onTaskStatus>[1])) {
          runnerRef?.requestMilestoneCompaction('milestone:task-closed');
        }
        return row;
      } catch (e) {
        console.warn(`[coder] updateTaskStatus failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    clearTasksState: async () => {
      try {
        const cleared = await store.clearTasksState(session.id);
        // Also clear the compact todos projection. Otherwise archive_task_list
        // would leave stale checklist state that resume could rehydrate.
        await store.setSessionTodos(session.id, null);
        if (cleared) tasksStateCache = null;
        return cleared;
      } catch (e) {
        console.warn(`[coder] clearTasksState failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    getTasksState: () => tasksStateCache,
    completeInlineTaskRun: inlineRunProjection(store, session.id),
    // Session Drive sinks (migrations 125/126) — back the read_plan /
    // save_note / list_notes / recall_investigations tools. Preserve storage
    // errors: an unreadable plan or note is not evidence that it is absent.
    sessionDrive: {
      readActivePlan: async (signal) => {
        const p = await store.getLatestPlan(session.id, signal);
        return p ? { text: p.plan_text, status: p.status } : null;
      },
      remember: async (input, beforePublish) => {
        const row = await store.rememberMemory(session.id, input, beforePublish);
        // Reload only the small notes projection, retaining the exact pinned /
        // automatic-note policy without rebuilding history and investigations.
        sessionStateDataCache = { ...sessionStateDataCache, notes: await store.listSessionStateNotes(session.id) };
        return { title: row.title };
      },
      listMemory: memOpts => store.listSessionMemory(session.id, memOpts ?? {}),
      recallInvestigations: async (query, limit, signal) => {
        signal?.throwIfAborted();
        // Semantic first through the host-owned Knowledge index. Missing
        // generation/provider/worker returns no ids and falls through to the
        // always-available relational lexical recall below.
        try {
          const semantic = getInvestigationSemanticIndex();
          if (semantic) {
            const semanticLimit = limit ?? 8;
            const ids = await semantic.search({ sessionId: session.id, query, limit: semanticLimit }, signal);
            signal?.throwIfAborted();
            const hits = await store.recallInvestigationsByIds(
              session.id,
              ids,
              semanticLimit,
              signal,
            );
            if (hits.length > 0) return hits;
          }
        } catch {
          signal?.throwIfAborted();
          /* fall through to keyword */
        }
        return store.recallInvestigations(session.id, query, limit, signal);
      },
    },
    conversationHistory: {
      list: (chapterOpts) => store.listConversationChapters(session.id, chapterOpts),
      search: (query, chapterOpts) => store.searchConversationChapters(session.id, query, chapterOpts),
      get: (chapterId) => store.getConversationChapter(session.id, chapterId),
      source: (chapterId, chapterOpts) => store.listConversationChapterSource(session.id, chapterId, chapterOpts),
    },
    // Durable project memory ports (save_note scope 'project' + recall_memory).
    // Gated on the per-project toggle (any linked member for a global session);
    // absent ports → tools answer clearly. Writes land on the primary real
    // project; recall reads all linked projects, interleaved and labeled.
    agentReads: opts.agentReads,
    projectMemory:
      opts.projectMemory && anyMemoryEnabled
        ? {
            save: (entry) => opts.projectMemory!.save(project.id, project.name, entry),
            recall: async (query, limit, signal) => {
              signal?.throwIfAborted();
              if (memoryReadProjects.length <= 1) {
                return opts.projectMemory!.recall(project.id, project.name, query, limit, signal);
              }
              const perProject = await mapProjectsConcurrent(
                memoryReadProjects,
                (p) =>
                  opts
                    .projectMemory!.recall(p.id, p.name, query, limit, signal)
                    .then((rows) => ({ name: p.name, rows }))
                    .catch(() => { signal?.throwIfAborted(); return { name: p.name, rows: [] }; }),
              );
              signal?.throwIfAborted();
              return interleaveLabeled(perProject, limit);
            },
            ...(opts.projectMemory.list
              ? { list: (limit, type, signal) => opts.projectMemory!.list!(project.id, project.name, limit, type, signal) }
              : {}),
            ...(opts.projectMemory.forget
              ? { forget: (target) => opts.projectMemory!.forget!(project.id, project.name, target) }
              : {}),
          }
        : undefined,
    // Global USER memory (save_note scope 'user') — NOT gated by the project
    // toggle. Reuses the project-memory host port pointed at the reserved user
    // project (id 0); db.create derives scope='user' from the category.
    userMemory: opts.projectMemory
      ? {
          save: (entry) => opts.projectMemory!.save(0, '__user__', entry),
          recall: (query, limit, signal) => opts.projectMemory!.recall(0, '__user__', query, limit, signal),
          ...(opts.projectMemory.list
            ? { list: (limit, type, signal) => opts.projectMemory!.list!(0, '__user__', limit, type, signal) }
            : {}),
          ...(opts.projectMemory.forget
            ? { forget: (target) => opts.projectMemory!.forget!(0, '__user__', target) }
            : {}),
        }
      : undefined,
    companyContext: opts.companyContext,
    // Coder session id — keys per-agent resources (preview/devtools window).
    sessionId: session.id,
    // Host-established opaque AgentRun identity. It exists before the worker
    // emits run_started, so an immediate child spawn never races that mirror.
    controlPlaneParentAgentRunId: opts.controlPlaneParentAgentRunId,
    // Project id — lets project-aware tools (rag_search_docs scoping,
    // <indexed-docs> hint) resolve linked doc collections.
    projectId: project.id,
    // Per-project PHP/Python (NOT Node) on PATH for shell tools. Resolved once
    // per run by the host-supplied resolver; local sessions only (sandbox runs
    // in a container with its own runtimes, so skip when builder-bound).
    runtimeEnv: sandboxBinding ? undefined : opts.resolveRuntimeEnv?.(db, project.id),
    // Surface indexing status to tools so DB-dependent paths can fall back
    // to disk/regex/tree-sitter instead of returning empty results.
    projectIndexed: undefined, // set after isIndexed is computed (see below)
    // Ports: sandbox-backed when the session is in builder mode,
    // otherwise local host filesystem/shell. Tools consume `ctx.ports`
    // uniformly and never branch on mode.
    ports: {
      fs: fsPort,
      shell: shellPort,
    },
  };

  // Load existing history FIRST so we can detect fresh vs resumed sessions
  // without a duplicate DB call. The block below (previously here) is now
  // merged into this one.
  const existingEarly = await store.loadSessionWithMessages(session.id);
  const outcomeRecovery = await createSessionOutcomeRecovery({ store, sessionId: session.id,
    initialState: existingEarly?.tool_outcome_state });
  toolContext.outcomeRecovery = outcomeRecovery.state;
  toolContext.onToolOutcomeTerminal = (receipt, originRunId) => outcomeRecovery.observe(receipt, originRunId ?? runnerRef?.runId);
  const initialMessagesEarly: AgentMessage[] = existingEarly?.messages ?? [];
  // A durable compaction can leave a session with a summary but zero visible
  // rows (full "summarize & clear") — that's still a resumed session, not fresh.
  const hasHistory0 = initialMessagesEarly.length > 0 || !!existingEarly?.session.compaction_summary;

  // On session resume, recover tasks stuck in 'running' — the previous runner
  // died before the task could finish. Mark them as 'interrupted' so the model
  // can retry via execute_task.
  if (hasHistory0) {
    await store.recoverStaleTasks(session.id);
  }

  // Resolve profile here (before buildSystemPrompt) so the prompt can render
  // the tier hint. Priority: explicit opts.profile → CODER_PROFILE env →
  // agentDef.profile → derived from history (resumed) or 'bootstrap' (fresh).
  //
  // Resumed sessions: instead of blanket 'full', scan the history's tool_use
  // blocks and pick the smallest profile that covers what was actually used.
  // Most resumed conversations only ever used bootstrap tools — promoting to
  // 'full' just to avoid hiding tools from history was paying tokens for
  // nothing on every turn.
  const historyToolNames: string[] = [];
  if (hasHistory0) {
    for (const m of initialMessagesEarly) {
      for (const b of m.content) {
        if (b.type === 'tool_use') historyToolNames.push(b.name);
      }
    }
  }
  // Agent Decision Engine runtime guidance. Default-off at the host layer: the
  // value is only computed when a caller explicitly enabled guidance, guardrail,
  // or ask-before-switch. It is pure/cheap, but keeping it gated preserves the
  // prior byte shape for sessions with all flags off.
  const agentDecisionContext = {
    currentAgent: effectiveAgentId,
    hasHistory: hasHistory0,
  };
  const currentTurnIntent = classifyIntent(opts.userMessage ?? '');
  const agentDecisionGuidance = (
    opts.agentDecisionGuidanceEnabled ||
    opts.agentDecisionSoftGuardrail ||
    opts.agentDecisionAskBeforeSwitch
  )
    ? decisionGuidanceForTask(opts.userMessage ?? '', agentDecisionContext)
    : undefined;
  const agentDecisionTelemetry = opts.agentDecisionTelemetryEnabled
    ? decisionTelemetryForTask(opts.userMessage ?? '', agentDecisionContext)
    : undefined;

  // Task-preflight seed — meaningful only for a FRESH session; a resumed
  // conversation carries better signals (history profile + re-pins). The
  // seed's profile beats the turn-1 keyword heuristic but loses to any
  // explicit choice (opts.profile / CODER_PROFILE / agentDef).
  const preflightSeed = !hasHistory0 ? opts.preflight : undefined;
  // Runtime guidance may render as a preflight reminder even when the host did
  // not provide a real preflight seed. Keep it separate so guidance-only does
  // not accidentally activate seeded tool caps, profile hints, or pinned tools.
  const preflightHintSeed = !hasHistory0
    ? (
      agentDecisionGuidance && opts.agentDecisionGuidanceEnabled
        ? { ...(preflightSeed ?? {}), agentDecisionGuidance }
        : preflightSeed
    )
    : undefined;
  // Sticky toolset (mig 142): profile/pins/cap persist on the session and
  // only ever WIDEN. Re-inferring from the loaded history tail every run
  // made the visible tool array flip between runs (118 ↔ ~60 observed in
  // session 991) — and the tools array is the FIRST prompt-cache segment,
  // so every flip busted the whole prefix on the next round's turn 1.
  const stickyToolset = true;
  const persistedToolset = stickyToolset
    ? parseToolsetState(session.tool_profile, session.tool_state_json)
    : null;
  // Seeded sessions cap the visible tool list at min(model cap, this) —
  // real reduction even on large-catalog models. Required pins survive.
  // The cap is persisted (widen-only state) so resumes rebuild the SAME
  // visible membership instead of dropping the cut and re-flipping the array.
  const seededToolCap = preflightSeed
    ? (opts.runtimePolicy?.capabilities.visibleToolCap ?? 28)
    : undefined;
  const managedToolCap = opts.initialVisibleToolCap != null && opts.initialVisibleToolCap > 0
    ? opts.initialVisibleToolCap
    : undefined;
  const sessionToolCap = managedToolCap
    ?? seededToolCap
    ?? persistedToolset?.visibleCap
    ?? opts.runtimePolicy?.capabilities.visibleToolCap;
  if (stickyToolset && sessionToolCap != null) {
    try { await store.mergeSessionToolsetState(session.id, { visibleCap: sessionToolCap }); } catch { /* best-effort */ }
  }
  const profileResolution = resolveSessionProfile({
    explicitProfile:
      opts.profile ??
      (opts.runtimePolicy?.capabilities.profile === 'auto'
        ? undefined
        : opts.runtimePolicy?.capabilities.profile) ??
      (agentDef?.profile),
    hasHistory: hasHistory0,
    historyToolNames,
    persisted: persistedToolset,
    preflightProfile: preflightSeed?.profile,
    userMessage: opts.userMessage ?? '',
    stickyEnabled: stickyToolset,
  });
  const preResolvedProfile: CoderProfile = profileResolution.profile;
  if (stickyToolset && profileResolution.persistAs) {
    try { store.setSessionToolProfile(session.id, profileResolution.persistAs); } catch { /* best-effort */ }
  }

  // ─── Skills ────────────────────────────────────────────────────
  // Opens a long-lived SkillStore that survives until the runner's `done`
  // promise resolves — the runner reads it every turn from inside
  // `assembleMessagesForChat` to materialize the `<active_skills>` block
  // for messages the user sent with sidebar picks. Built on the SHARED central
  // handle (Phase 2) so it adds no new connection; its `close()` is a no-op.
  const skillStore = new SkillStore(db.raw());
  let resolvedSkills: ResolvedSkill[] = [];
  try {
    const skillProjectIds = session.is_global && unionProjectLinks.length > 0
      ? unionProjectLinks.map((linked) => linked.project_id)
      : [project.id];
    resolvedSkills = resolveActiveWorkspaceSkills(
      skillStore,
      skillProjectIds,
      Array.isArray(session.state.tools.active_skills)
        ? session.state.tools.active_skills.filter(
            (value): value is string => typeof value === 'string',
          )
        : null,
    );
  } catch (e) {
    console.warn(`[coder] skill resolution failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const skillTemplateCtx: SkillTemplateContext = {
    PROJECT_NAME: project.name,
    PROJECT_ROOT: project.root_path,
    SESSION_ID: String(session.id),
    OS: process.platform,
    TIMESTAMP: new Date().toISOString(),
  };

  if (resolvedSkills.length > 0) {
    // Discovery tools — always registered for all active skills.
    // installedNamespaces enriches list_skill_namespaces with repo/commit;
    // best-effort (a DB read failure must not block the session).
    let installedNamespaces: ReturnType<typeof listInstalledNamespaces> | undefined;
    try {
      installedNamespaces = listInstalledNamespaces();
    } catch {
      installedNamespaces = undefined;
    }
    registry.registerAll(
      buildSkillDiscoveryTools(
        resolvedSkills,
        skillTemplateCtx,
        store,
        session.id,
        installedNamespaces,
      ),
    );

    // invoke_skill — only for tool-mode skills (logs usage)
    const toolModeSkills = resolvedSkills.filter(
      (s) => s.contextMode === 'tool' || s.contextMode === 'both',
    );
    if (toolModeSkills.length > 0) {
      registry.register(
        buildInvokeSkillTool(toolModeSkills, skillTemplateCtx, session.id, store),
      );
    }
  }

  // create_skill — registered unconditionally (navigate tier) so the agent can
  // author the FIRST skill in an empty catalog. Captures dbPath + registry for
  // tool-name validation and the trigger eval.
  registry.register(
    buildCreateSkillTool({ dbPath: config.dbPath, registry, projectId: project.id }),
  );
  const catalogOnlyCapabilities = resolvedSkills.map(skillAsCatalogCapability);

  // Detect indexing status — used for prompt conditioning and dashboard feedback.
  const projectStats = db.getStats(project.id);
  // Structural readiness is a persisted baseline, not the presence of an old
  // LLM/full-index run. The latter is being retired and no-op reconciliations
  // intentionally do not create history rows.
  const projectRow = project as typeof project & {
    file_count?: number | null;
    structural_indexed_at?: string | null;
    last_indexed?: string | null;
  };
  const indexedFileCount = projectRow.file_count ?? projectStats?.file_count ?? 0;
  const isIndexed = indexedFileCount > 0
    && Boolean(projectRow.structural_indexed_at || projectRow.last_indexed);
  const indexStatus: IndexStatus = { isIndexed, mcpAvailable: mcpBridgeOk };
  toolContext.projectIndexed = isIndexed;
  // Index-dependent tools stay registered even in dumb mode. Their handlers
  // query live storage on every invocation, so a session created before the
  // baseline can use them as soon as indexing completes without rebuilding
  // the registry. Until then each tool keeps its disk/FTS fallback or returns
  // the explicit readiness error supplied by its owner.

  // Optional repo map (B6). Auto-sized by indexed file count: 0 (<50 files),
  // 1500 chars (50-499), 3000 (500-1999), 4500 (≥2000). Set CODER_REPOMAP_TOKENS
  // to a positive integer to override the auto budget, or "0" to disable.
  // Skipped when the project has never been indexed (no symbols to map). The
  // turn-start readiness refresher below injects it into this SAME runner as
  // soon as the baseline appears; tool availability is never frozen.
  const repoMapBudget = resolveRepoMapBudget(db, project.id, isIndexed);
  const repoMap = repoMapBudget > 0
    ? buildRepoMap(db, project.id, repoMapBudget)
    : '';

  // Detected verify commands (B2-dyn) — package.json scripts + package
  // manager, rendered below the dynamic boundary next to the repo map so the
  // agent runs the project's REAL test/typecheck instead of guessing.
  const verifyCommands = sandboxBinding ? undefined : detectVerifyCommands(effectiveCwd);

  // The current agent loop is the only supported product behavior.
  const agentLoopV2EnvFlag = true;

  // Effective tool-approval mode (mig 131), resolved once here so the system
  // prompt's `# Permissions & sandbox` block and the runner's PermissionGate
  // (below) can't diverge. Company runs force 'unrestricted' (no board approval
  // UI yet); single sessions read the column (NULL → 'auto').
  const resolvedPermissionMode = opts.toolPermissionMode
    ?? (opts.companyContext ? 'unrestricted' : normalizeToolPermissionMode(session.tool_permission_mode));

  // Hierarchical AGENTS.md instructions for this project (root→cwd). Read-only,
  // budget-capped, safe on missing/malformed files. Our /init generates the
  // file; this finally reads it back into the prompt.
  const agentsMd = loadAgentsMd(project.root_path, effectiveCwd);

  // Config lock (mig 194): capture the resolved config on first run; on resume
  // diff against the stored lock and surface drift. Advisory only (dev-first) —
  // wrapped so a lock failure can never block a run.
  try {
    const currentLock = buildConfigLock({
      provider: session.provider,
      model: session.model,
      permissionMode: resolvedPermissionMode,
      executionMode: sessionExecutionMode ?? undefined,
      reasoningEffort: session.reasoning_effort_override,
      planDepth: session.plan_depth_override,
      responseLanguage: session.response_language_override,
      outputStyle: session.output_style_override,
      temperature: session.temperature_override,
      toolOutputCapLevel: session.tool_output_cap_level,
      nowMs: Date.now(),
    });
    const storedLock = normalizeConfigLock(
      await store.getConfigLock(session.id),
    );
    if (!storedLock) {
      await store.setConfigLock(session.id, { ...currentLock });
      await store.appendSessionEvent(
        session.id,
        'config.captured',
        {
          to_state: `${session.provider}/${session.model}`,
          actor: 'system',
        },
      );
    } else {
      const drift = diffConfigLock(storedLock, currentLock);
      if (drift.length > 0) {
        console.warn(`[coder] session ${session.id} config drift on resume: ${drift.join('; ')}`);
        await store.appendSessionEvent(
          session.id,
          'config.drift',
          {
            reason: drift.join('; '),
            actor: 'resume',
          },
        );
      }
    }
  } catch (e) {
    console.warn(`[coder] config-lock check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const availableTools = new Set(
    registry
      .list()
      .map((tool) => tool.name)
      .filter(
        (name) =>
          !globalDisabledTools?.has(name)
          && !sessionDisabledTools.has(name),
      ),
  );
  const effectiveMcpAvailable = [...availableTools].some((name) => name.startsWith('mcp__'));
  const promptContext: PromptContext = {
    projectName: project.name,
    projectRoot: project.root_path,
    globalWorkspace: toolContext.globalWorkspace,
    os: process.platform,
    planMode: opts.planMode,
    specMode: opts.specMode ?? effectiveAgentId === 'spec',
    providerFamily: normalizeProviderFamily(session.provider),
    profile: preResolvedProfile,
    sessionId: String(session.id),
    customTiers: customTierSummary.size > 0
      ? [...customTierSummary.entries()].map(([tier, info]) => ({
          tier,
          displayName: info.displayName,
          toolCount: info.toolCount,
        }))
      : undefined,
    mcpAvailable: effectiveMcpAvailable,
    isIndexed,
    repoMap,
    verifyCommands,
    agentLoopV2: agentLoopV2EnvFlag,
    agentId: effectiveAgentId ?? undefined,
    // Plan-depth directive (consumed only in plan mode; the `spec` agent is
    // excluded in buildSystemPrompt). Explicit opt wins (company/role), else
    // the sticky session column (migration 151), else `normal`. The value is
    // normalized defensively in buildPlanDepthBlock. Cache-stable axis above
    // SYSTEM_PROMPT_DYNAMIC_BOUNDARY.
    planDepth:
      opts.planDepth
      ?? (session.plan_depth_override as 'simple' | 'normal' | 'complex' | null)
      ?? 'normal',
    // Response-language directive (mig 177): session override wins, else the
    // per-project default, else the neutral "user's language" form. Cache-stable
    // axis above SYSTEM_PROMPT_DYNAMIC_BOUNDARY.
    responseLanguage:
      session.response_language_override
      ?? (project as { default_response_language?: string | null }).default_response_language
      ?? undefined,
    // Output style (mig 178): proactive (default → no block) | explanatory | learning.
    outputStyle:
      (session.output_style_override as 'proactive' | 'explanatory' | 'learning' | null)
      ?? undefined,
    blockCodeComments:
      opts.blockCodeComments ?? (session.block_code_comments !== false),
    // Unsupervised framing (G3): ONLY when a caller explicitly marks the run as
    // headless (cron / scheduled / CI). NOT derived from company-subordinate
    // status: subordinates lack `ask_user` but DO have `ask_master` (blocks
    // until the master — and ultimately a human — answers), so they are NOT
    // unsupervised, and the autonomous "no human is watching, don't ask" framing
    // would contradict their escalation model.
    unsupervised: opts.unsupervised ?? false,
    sessionDrive: availableTools.has('save_note') || availableTools.has('read_plan'),
    // "Images & vision" section is only rendered when the model can't see
    // images natively (or the composer forces the describe-images path).
    modelCanSeeImages: opts.describeImages ? false : opts.modelSupportsVision,
    // Effective permission/sandbox policy surfaced to the model: the real
    // writable root (sandbox workdir or project root) + the approval mode.
    // Cache-stable axis above SYSTEM_PROMPT_DYNAMIC_BOUNDARY.
    permissions: {
      writableRoots: [effectiveCwd, ...externalRoots.filter((root) => root.access === 'write').map((root) => root.rootPath)],
      readableRoots: externalRoots.filter((root) => root.access === 'read').map((root) => root.rootPath),
      canRequestExternalRoots: allowExternalFilesystemRoots,
      approvalMode: resolvedPermissionMode,
    },
    // AGENTS.md project instructions (loaded above). '' when none → block omitted.
    agentsMd,
    // Codex-faithful mode switch: Ultra permits useful, bounded proactive
    // research; an explicit non-Ultra selection revokes that permission.
    // The prompt builder fails closed when spawn_agent is unavailable.
    multiAgentMode: ultraExecutionEnabled
      ? 'proactive'
      : sessionExecutionMode != null
        ? 'explicit_request_only'
        : undefined,
    ultraPolicy: ultraPreset,
    availableTools,
  };

  const fixedSections = [
    opts.customAgentPrompt?.trim() ? `# Custom agent instructions\n${opts.customAgentPrompt.trim()}` : '',
    opts.companyPromptBlock ?? '',
  ];
  let sessionSuffix = sessionNetwork ? '\n\n' + await sessionNetwork.context(session.id) : '';

  // Append skill awareness block. Mode resolution priority:
  //   1. Explicit env CODER_SKILLS_PROMPT_MODE = lazy | compact | matched | full
  //   2. Company context present (master/subordinate) → 'matched' (existing
  //      behaviour: matcher filters skills by role/tag/path)
  //   3. Otherwise → 'lazy' (default — skills discoverable via get_skills_list
  //      tool, ~30 tokens vs ~3000 for full)
  //
  // Sessions with 30+ skills used to spend ~3000 tokens of every turn just
  // describing skills the agent would never call. The lazy default trims
  // that to a single pointer while keeping discovery a tool call away.
  let skillsModeUsed: 'lazy' | 'matched' | 'none' = 'none';
  if (resolvedSkills.length > 0) {
    const inCompany = !!opts.companyContext;
    if (!inCompany) {
      sessionSuffix += buildLazySkillsSection(resolvedSkills, availableTools);
      if (availableTools.has('get_skill_content')) skillsModeUsed = 'lazy';
    } else {
      // Path triggers fire from `recentFiles`. Outside company context we
      // approximate that with file-shaped tokens in the user message
      // (relative paths and *.ext mentions). Misses some — that's fine,
      // the skill is still discoverable via get_skills_list.
      const userMsg = opts.userMessage ?? '';
      const recentFiles = extractFilePathsFromText(userMsg);
      const matchCtx: SkillMatchContext = {
        role: opts.companyContext?.agentRole,
        mode: opts.companyContext?.isMaster ? 'master' : opts.companyContext ? 'subordinate' : undefined,
        cwd: project.root_path,
        recentFiles,
        sessionTags: [],
      };
      const matched = matchSkills(resolvedSkills, matchCtx);
      if (matched.length > 0) {
        const instructions = buildMatchedSkillsPromptSection(matched, skillTemplateCtx, availableTools);
        sessionSuffix += instructions;
        if (instructions) skillsModeUsed = 'matched';
      } else {
        // No matches: degrade to lazy rather than dumping the full list.
        sessionSuffix += buildLazySkillsSection(resolvedSkills, availableTools);
        if (availableTools.has('get_skill_content')) skillsModeUsed = 'lazy';
      }
    }
  }

  function composeSessionPrompt(): string {
    const { agentId, planMode = false, specMode = false } = promptContext;
    const canRevisePlan = !!approvedPlanForRevision(toolContext, { agentId, planMode, specMode, isSubagent: false });
    let prompt = buildSystemPrompt({ ...promptContext, canRevisePlan });
    for (const section of fixedSections) prompt = appendStaticPromptSection(prompt, section);
    if (availableTools.has('diagram_create') && (agentId === 'diagram' || persistedToolset?.extraTiers?.includes('diagram'))) {
      prompt = appendStaticPromptSection(prompt, buildDiagramGuidance());
    }
    return prompt + sessionSuffix;
  }

  let systemPrompt = composeSessionPrompt();
  // Persist the fully assembled system prompt for the Input tab in the
  // session details modal. Dedup by hash inside SessionStore — typical
  // restarts are byte-identical (cache prefix is intentionally stable).
  store.recordSessionInput({
    session_id: session.id,
    kind: 'system_prompt',
    source_label: 'turn-start',
    content: systemPrompt,
    meta: {
      provider: session.provider,
      profile: preResolvedProfile,
      planMode: !!opts.planMode,
      mcp_available: mcpBridgeOk,
      skill_ids: resolvedSkills.map((s) => s.id),
      skills_mode: skillsModeUsed,
      company_role: opts.companyContext?.agentRole ?? null,
      is_master: !!opts.companyContext?.isMaster,
    },
  });

  // Reuse the history we loaded early for profile resolution. When a durable
  // compaction boundary is set, PREPEND its summary so the model starts from
  // "summary + recent tail" (the loaders already return only id > boundary).
  const compactionSummary0 = existingEarly?.session.compaction_summary;
  const initialMessages: AgentMessage[] = compactionSummary0
    ? [{ role: 'user', content: [{ type: 'text', text: compactionSummary0 }] }, ...initialMessagesEarly]
    : initialMessagesEarly;

  const activeTiers = profileToTiers(preResolvedProfile);
  // Functional capabilities are separate from the global bootstrap identity.
  // Registration remains the authority boundary; this derivation only makes
  // capabilities already owned by THIS runtime visible from turn 1. Visual
  // Company roles and the database role inherit their defining preview/db
  // tiers directly instead of relying on preset pins.
  for (const tier of contextualTiersForRuntime({
    company: opts.companyContext != null,
    sandbox: opts.companyContext?.sandbox != null,
    qa: hasGenericQaCapability,
    isMaster: opts.companyContext?.isMaster === true,
    previewAvailable: opts.previewAvailable,
    browserAvailable: opts.browserAvailable,
    agentId: effectiveAgentId,
    companyRole: opts.companyContext?.agentRole,
  })) {
    activeTiers.add(tier);
  }
  for (const tier of opts.initialToolTiers ?? []) {
    if (typeof tier === 'string' && tier.trim()) activeTiers.add(tier.trim() as ToolTier);
  }
  // Sticky extra tiers (mig 142): contextual tiers an OLDER run unlocked via
  // the retired expand_toolset. Still read so those sessions keep their
  // workflow floors and diagram guidance; nothing writes new ones. A tier
  // name that no longer exists matches no tool — harmless.
  if (persistedToolset) {
    for (const t of persistedToolset.extraTiers) activeTiers.add(t as ToolTier);
  }
  // Required pins: durable role/custom-agent presets plus the research
  // agent's two defining tools. The stable catalog always publishes them;
  // runtime discovery goes through find_tools + code_exec and never pins.
  // Persisted pins from older runs (mig 142) are read tolerantly and ignored.
  const configuredInitialPins = new Set([
    ...(opts.initialPinnedTools ?? []),
    ...(effectiveAgentId === 'research' ? ['web_search', 'web_fetch'] : []),
  ]);
  // ─── Runtime hooks ─────────────────────────────────────────────
  const hookRegistry = new RuntimeHookRegistry();
  const toolResultObservers: Array<(event: ToolSettledEvent) => void> = [];
  if (opts.companyContext && !opts.companyContext.isMaster && opts.companyContext.agentRunId != null) {
    registerCompanyHooks(
      hookRegistry,
      opts.companyContext.orchestrator,
      opts.companyContext.agentRunId,
      opts.companyContext.agentRole,
    );
  }

  // ─── Sandbox preview auto-reload (builder mode only) ──────────
  // When an agent writes/edits a file inside the sandbox, publish a
  // `sandbox.file_changed` event on the metaBus so the dashboard can
  // refresh the iframe without the user clicking reload. Debounced so
  // a burst of edits in a single turn collapses into one reload.
  if (opts.companyContext?.sandbox) {
    const orch = opts.companyContext.orchestrator;
    const pending = new Set<string>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    toolResultObservers.push((ctx) => {
      if (ctx.result?.isError) return;
      const rawPaths = changedToolPaths(ctx.toolName, ctx.toolArgs);
      for (const raw of rawPaths) {
        if (raw == null) continue;
        const path = typeof raw === 'string' ? raw : String(raw);
        if (path) pending.add(path);
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const paths = [...pending];
        pending.clear();
        debounceTimer = null;
        try {
          orch.sandboxService.publishFileChanged(paths);
        } catch {
          // best-effort — never crash the runner on a UI-notification hook
        }
      }, 300);
    });
  }

  // ─── Incremental symbol re-indexing ──────────────────────────
  // Keep the symbol DB fresh as the agent edits files. Tree-sitter only —
  // no LLM cost. Register this hook even when the session starts before its
  // first baseline: once the scan settles, later edits in the SAME live run
  // must participate in incremental indexing. Fire and forget.
  if (!sandboxBinding) {
    toolResultObservers.push((ctx) => {
      if (ctx.result?.isError) return;
      const rawPaths = changedToolPaths(ctx.toolName, ctx.toolArgs);
      const rawStrs = rawPaths
        .filter((raw): raw is string => raw != null)
        .map((raw) => (typeof raw === 'string' ? raw : String(raw)))
        .filter(Boolean);
      if (rawStrs.length === 0) return;
      // The public global-session namespace selects a real root through the
      // first `<project-slug>/` path segment. Keep the hidden project selector
      // only for older nested callers that still send it out of schema.
      const reqProj =
        typeof ctx.toolArgs.project === 'string'
          ? ctx.toolArgs.project.trim()
          : typeof ctx.toolArgs.project_name === 'string'
            ? ctx.toolArgs.project_name.trim()
            : '';
      const target =
        reqProj && reqProj !== workspace.displayName
          ? secondaryRoots.find((r) => r.slug === reqProj || r.name === reqProj)
          : undefined;
      for (const rawStr of rawStrs) {
        const namespacedPath = target
          ? `${target.slug}/${rawStr.replace(/^(?:\.?[\\/])+/, '')}`
          : rawStr;
        const resolved = resolveWorkspacePath(namespacedPath, toolContext, 'write');
        if (!resolved.ok || resolved.external || resolved.projectId == null) continue;
        // Normalize to the same root-relative shape stored in `files.path`.
        const relPath = resolved.relativePath
          .replace(/\\/g, '/')
          .replace(/^\.\//, '')
          .replace(/\/+$/, '');
        if (!relPath || relPath === '.') continue;
        const idxProjectId = resolved.projectId;
        // Async, non-blocking. `loadIncrementalIndexer` (module-level lazy
        // singleton above) defers the tree-sitter WASM load to the first
        // mutation in this process — sessions that never edit code pay
        // zero cost. Subsequent calls reuse the cached `indexFileNow`
        // reference without re-entering the module resolver.
        void (async () => {
          try {
            const indexFileNow = await loadIncrementalIndexer();
            const abs = resolved.abs;
            const content = await (toolContext.ports?.fs ?? defaultLocalFilesystemPort()).readFile(abs);
            await indexFileNow(db, idxProjectId, relPath, content);
          } catch {
            // best-effort — never crash on incremental refresh failures
          }
        })();
      }
    });
  }

  // ─── Fallback chain ───────────────────────────────────────────
  toolContext.onToolSettled = event => {
    for (const observe of toolResultObservers) {
      try { observe(event); } catch { /* index/preview observations are best-effort */ }
    }
  };
  // Always defined so the runner can refresh OAuth credentials (e.g. the
  // Copilot 25-min token) on 401 even when no fallback chain is configured.
  const createProviderForFallback = async (name: string, model: string) => {
    return budgetedProvider(await createCoderProvider(name, model), sharedBudget);
  };
  let fallbackChain: import('@mcp/code-agent/core/fallback.js').FallbackChain | undefined;
  // App role fallbacks are owned by the Company lifecycle, which records the
  // effective model and fallback reason on the bundle agent-run entity before retrying.
  // Letting the coder-local provider/env chain run here could silently jump to
  // a global mini model without updating that provenance. Generic Company and
  // solo sessions retain their existing fallback chain unchanged.
  if (!isAppStudioCompany) {
    try {
      const { buildFallbackChain } = await import('@mcp/code-agent/core/fallback.js');
      const providerStore = new ProviderStore(config.dbPath);
      const sessionFallback = await store.getSessionFallback(session.id);
      const providerChain = providerStore.getFallbackChain(session.provider);
      providerStore.close();
      const chain = buildFallbackChain(
        sessionFallback,
        providerChain,
        undefined,
      );
      if (chain.entries.length > 0) {
        fallbackChain = chain;
        console.log(`[coder] Fallback chain: ${chain.entries.map((e) => `${e.provider}:${e.model}`).join(' → ')}`);
      }
    } catch {
      // Fallback config not available (migration not run yet) — skip silently
    }
  }

  const verificationEvidenceEnabled = !opts.companyContext;

  // ─── Context window (DB-first, registry fallback) ────────────────
  // The DB is the source of truth WHEN populated, but ZAI / new model
  // releases / hand-imported configs frequently leave it null. Fall back
  // to the static registry (which now has prefix-matching, see
  // capabilities.ts) so the dashboard's context bar renders for legacy
  // sessions without forcing a re-discovery.
  let sessionContextWindow: number | null = null;
  let sessionModelCanReason: boolean | null = null;
  try {
    const ps = new ProviderStore(config.dbPath);
    const [sessionModelId, sessionModelMode = ''] = session.model.split('::');
    const dbModel = ps.listModels(session.provider).find((m) =>
      m.model_id === sessionModelId && (!sessionModelMode || m.mode === sessionModelMode));
    ps.close();
    sessionContextWindow = dbModel?.context_window ?? null;
    sessionModelCanReason = dbModel?.can_reason ?? null;
  } catch {
    // Non-fatal — registry fallback below
  }
  if (sessionContextWindow == null && session.model) {
    const { getRegistryContextWindow } = await import('@mcp/code-agent/providers/capabilities.js');
    const fromRegistry = getRegistryContextWindow(session.model);
    if (fromRegistry != null) {
      sessionContextWindow = fromRegistry;
      console.log(
        `[coder] context_window resolved via registry fallback for ${session.provider}/${session.model}: ${fromRegistry}`,
      );
    }
  }

  // Phase Profiles (Camada 2) was REMOVED — sessions run on a single
  // (provider, model) for their entire lifetime. The runner ignores any
  // deprecated phase-profile metadata imported into an old bundle.

  // The mandatory agent loop injects a live context block per turn,
  // injects a live <active-context> block per turn, adds a static "Agent
  // loop" framing to the system prompt, applies a stop-guard for unfinished
  // todos, includes a recap on auto-continue, and refuses tool calls that
  // and refuses tool calls that produce identical content to a recent result.
  const agentLoopV2 = agentLoopV2EnvFlag;

  // Optional cheap provider for compaction/chapter generation. Resolution is
  // done once per run so the Compacting node stays provider-agnostic and the
  // tool/system prefix remains stable. A missing/broken binding is a clean
  // fallback to the active chat provider.
  let compactionProvider: ChatProvider = provider;
  const compactionSummaryOptions: NonNullable<
    import('@mcp/code-agent/core/runner/types.js').RunnerOptions['compactionSummaryOptions']
  > = {};
  try {
    const resolver = new PipelineProviderResolver(
      new PipelineProviderBindingsStore(db.raw()),
      new ProviderStore(db.raw()),
    );
    const bound = await resolver.resolveOrNull('code-agent', 'compaction', {
      sessionId: session.id,
      companySessionId: opts.companyContext?.companySessionId,
    });
    if (bound) {
      compactionProvider = await createCoderProvider(bound.provider.id, bound.modelId);
      const positiveNumber = (value: unknown): number | undefined => (
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
      );
      const temperature = typeof bound.config.temperature === 'number'
        && Number.isFinite(bound.config.temperature)
        ? Math.max(0, Math.min(2, bound.config.temperature))
        : undefined;
      compactionSummaryOptions.timeoutMs = positiveNumber(bound.config.timeout_ms);
      compactionSummaryOptions.budgetChars = positiveNumber(bound.config.budget_chars);
      compactionSummaryOptions.maxOutputTokens = positiveNumber(bound.config.max_tokens);
      compactionSummaryOptions.temperature = temperature;
      compactionSummaryOptions.reasoningEffort = typeof bound.config.reasoning_effort === 'string'
        ? bound.config.reasoning_effort
        : undefined;
    }
  } catch (e) {
    console.warn(
      `[coder] compaction provider binding unavailable; using session model: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // All registration, allowlisting and source readiness decisions are now
  // complete. From this point through terminal cleanup the attempt owns an
  // immutable catalog snapshot; a late MCP/plugin is visible only to the next
  // attempt assembled by the host.
  registry.seal();

  // Optional Policy Engine comparison diagnostics. Production defaults leave
  // the observer absent; real permission/scope/recovery gates stay active.
  // The legacy context for explicit diagnostic runs is read LIVE through
  // `runnerRef` (assigned right after construction) so mid-run plan/spec
  // approval applies to the next shadow evaluation.
  // ClaudeOpen exposes one ordered lifecycle registry spanning provider,
  // tool/capability and session boundaries. Keep the same lifecycle cohesion
  // here while preserving our worker transport: one bus per run, absent when
  // the kill switch is off, and optionally injectable by trusted in-process
  // callers/tests.
  const runtimeHookBus = opts.hookBus ?? createRuntimeHookBus();
  const policyShadowComposition = createPolicyShadowPort({
    persistence: new FsPolicyShadowRepository(store),
    registry,
    sessionContext: {
      getLegacyContext: () => ({
        planMode: !!opts.planMode,
        planApproved: runnerRef?.isPlanApproved() ?? false,
        specMode: opts.specMode ?? (effectiveAgentId === 'spec'),
        specApproved: runnerRef?.isSpecApproved() ?? false,
        // Read the same live inline-task boundary as the legacy gate. Shadow
        // comparisons must evaluate the effective scope, otherwise task-scoped
        // allows are misclassified as policy divergences.
        taskScope: runnerRef?.currentTaskScopeId()
          ? {
              id: runnerRef.currentTaskScopeId()!,
              files: runnerRef.currentTaskScopeFiles() ?? [],
            }
          : null,
      }),
      background: false,
      sessionId: session.id,
      // HTTP/main passes the opaque control-plane identity before the runner
      // id mirror exists; keep root policy decisions correlated to AgentRun.
      agentRunId: opts.controlPlaneParentAgentRunId,
    },
    hookBus: runtimeHookBus,
    catalogOnlyCapabilities,
    log: (level, msg) => {
      if (level === 'warn') console.warn(msg);
      else console.log(msg);
    },
  });

  const runner = new CoderRunner({
    provider: budgetedProvider(provider, sharedBudget),
    compactionProvider: compactionProvider ? budgetedProvider(compactionProvider, sharedBudget) : undefined,
    contextWindow: sessionContextWindow,
    compactionSummaryOptions,
    registry,
    catalogOnlyCapabilities,
    hookBus: runtimeHookBus,
    // The Executing node emits `turn_start` before awaiting this callback.
    // Our listener below enqueues the previous turn into `flushChain`
    // synchronously, so this is a real write barrier: a transcript transaction must
    // commit before another provider/tool turn may begin.
    awaitTurnPersistence: async () => {
      await flushChain;
      if (criticalTranscriptPersistenceError) {
        throw criticalTranscriptPersistenceError;
      }
    },
    systemPrompt,
    systemPromptForAgent: (agent) => {
      promptContext.agentId = agent.id;
      promptContext.planMode = agent.planMode;
      promptContext.specMode = !!agent.specMode;
      systemPrompt = composeSessionPrompt();
      return systemPrompt;
    },
    toolContext,
    initialMessages,
    sessionId: session.id,
    sessionStore: store,
    // Ultra chip for the dashboard (run_started.ultra) — session toggle vs
    // per-turn `ultracode` keyword.
    ...(ultraExecutionEnabled
      ? { executionUltra: (turnUltraTriggered ? 'turn' : 'session') as 'turn' | 'session' }
      : {}),
    // Metrics are immutable per-turn files in the same session bundle. The
    // filesystem writer serializes them with transcript commits; no SQLite
    // writer or cross-session lock participates.
    turnTelemetryStore: new FsTurnTelemetryRepository(store),
    skillStore,
    // Mem C — proactive project-memory retrieval. Wired only when the host
    // provided a retriever AND some read project has memory enabled (migration
    // 115); the Executing node awaits it before assembly and injects relevant
    // memory. A global session retrieves across every union member (interleaved
    // + labeled); a single project is the identity path.
    getRelevantProjectMemory:
      opts.memoryRetriever && anyMemoryEnabled
        ? async (taskText: string) => {
            // Single project: identity path — call the retriever directly so
            // error propagation/diagnostics are unchanged vs. the pre-union code.
            if (memoryReadProjects.length <= 1) {
              const p = memoryReadProjects[0];
              return opts.memoryRetriever!.retrieve(p.id, p.name, taskText);
            }
            const perProject = await mapProjectsConcurrent(
              memoryReadProjects,
              (p) =>
                opts
                  .memoryRetriever!.retrieve(p.id, p.name, taskText)
                  .then((rows) => ({ name: p.name, rows: [...rows] }))
                  .catch(() => ({ name: p.name, rows: [] as Array<{ id: string; title: string; content: string; staleNote?: string }> })),
            );
            return interleaveLabeled(perProject);
          }
        : undefined,
    onMemoryInjected: opts.memoryRetriever?.recordInjected
      ? ids => opts.memoryRetriever!.recordInjected!(ids)
      : undefined,
    // Mem C — LLM memory-query synthesizer for meta/continuation messages.
    // Wired only when the host provided one AND memory is enabled; the
    // Executing node calls it fail-open and falls back to its walk-back
    // heuristic when it returns null (or isn't wired at all).
    synthesizeMemoryQuery:
      opts.memoryQuerySynthesizer && anyMemoryEnabled
        ? (tail) => opts.memoryQuerySynthesizer!(tail)
        : undefined,
    // Session State Block data — non-company sessions only. The runner
    // renders plan/todos/notes/files/recall into a `<session-state>`
    // tail block per the window-scaled policy, so continuity never depends
    // on summarization alone. Best-effort: any read error → no block.
    getSessionStateData: opts.companyContext
      ? undefined
      : () => {
          try {
            return {
              ...sessionStateDataCache,
              activePlan: activePlanCache,
              todos: (tasksStateCache?.tasks ?? []).map((task) => ({
                status: task.status,
                label: task.title,
              })),
            };
          } catch {
            return null;
          }
        },
    // Project memory index (MEMORY.md-style) — direct store read (works in
    // workers too: each worker holds its own WAL handle). Gated on the toggle
    // (any union member for a global session); empty index → no injection. A
    // global session merges every constituent's index (labeled + re-ranked by
    // importance); a single project is the identity path.
    getProjectMemoryIndex:
      !opts.companyContext && anyMemoryEnabled
        ? () => {
            try {
              const per = perProjectIndexLimit(memoryReadProjects.length);
              return mergeMemoryIndex(
                memoryReadProjects.map((p) => ({
                  name: p.name,
                  entries: db
                    .listAgentMemoryIndex('project', p.id, per)
                    .map((m) => ({ title: m.name, category: m.type, importance: m.importance })),
                })),
              );
            } catch {
              return null;
            }
          }
        : undefined,
    // Session-scoped conversation chapter table of contents. Titles only;
    // full bodies/source messages stay behind recall_conversation.
    getConversationChapterIndex: async () => {
            try {
              return await store.getConversationChapterIndex(session.id);
            } catch {
              return null;
            }
          },
    getRelevantConversationChapters: async (taskText) => {
            try {
              return (
                await store.searchConversationChapters(
                  session.id,
                  taskText,
                  { limit: 2 },
                )
              )
                .items.slice(0, 2)
                .map((chapter) => ({
                  id: `conversation-chapter:${chapter.id}`,
                  title: chapter.title,
                  content: chapter.chapter_text.slice(0, 400),
                }));
            } catch {
              return [];
            }
          },
    // Global user-preferences index — NOT gated by the project toggle; injected
    // into every (non-company) session. Company subordinates get it via spawn
    // injection (system prompt) instead.
    getUserMemoryIndex:
      !opts.companyContext
        ? () => {
            try {
              return db
                .listAgentMemoryIndex('user', 0, 12)
                .map((m) => ({ title: m.name, category: m.type, excerpt: m.excerpt }));
            } catch {
              return null;
            }
          }
        : undefined,
    // (assignment below) — keeps recorder in sync with runner.turn
    // even though the runner is constructed after recorder. The recorder
    // reads `runnerRef?.turn` lazily, so this assignment closes the loop.
    maxTurns: opts.maxTurns ?? session.max_turns ?? undefined,
    maxAutoContinues:
      opts.maxAutoContinues ?? session.max_auto_continues,
    planMode: opts.planMode,
    // Fase 2.5 — shadow port (absent when flags off → zero behavior change).
    ...(policyShadowComposition ? { policyShadow: policyShadowComposition.port } : {}),
    ...(policyShadowComposition
      ? { policyShadowScopeFactory: policyShadowComposition.createScopedPort }
      : {}),
    // Mirror the same resolution used for the system-prompt's plan-depth block
    // so the runner's decision-gate nudge can skip `simple` tasks.
    planDepth:
      opts.planDepth
      ?? (session.plan_depth_override as 'simple' | 'normal' | 'complex' | null)
      ?? 'normal',
    specMode: opts.specMode ?? (effectiveAgentId === 'spec'),
    // Orchestration is independent of the user's provider reasoning controls.
    thinking: opts.thinking,
    thinkingBudgetTokens: opts.thinkingBudgetTokens,
    modelSupportsVision: opts.modelSupportsVision,
    describeImages: opts.describeImages,
    activeTiers,
    requiredPinnedTools: configuredInitialPins.size > 0
      ? configuredInitialPins
      : undefined,
    preflightHint: preflightHintSeed
      ? renderPreflightHint(preflightHintSeed, { bugWorkflow: false })
      : undefined,
    sessionToolCap,
    agentDecisionGuidance,
    agentDecisionTelemetry,
    agentDecisionSoftGuardrail: opts.agentDecisionSoftGuardrail,
    agentDecisionSoftGuardrailMinConfidence: opts.agentDecisionSoftGuardrailMinConfidence,
    agentDecisionAskBeforeSwitch: opts.agentDecisionAskBeforeSwitch,
    globalDisabledTools,
    sessionDisabledTools: sessionDisabledTools.size > 0 ? sessionDisabledTools : undefined,
    externalToolTiers: runtimeToolTiers,
    fallbackChain,
    createProvider: createProviderForFallback,
    verificationEvidenceEnabled,
    collectVerifyEvidence: verificationEvidenceEnabled
      ? () => buildVerifyEvidence(store, session.id)
      : undefined,
    hookRegistry: hookRegistry.hasHandlers ? hookRegistry : undefined,
    context_window: sessionContextWindow,
    isCompanySubordinate: opts.companyContext != null && !opts.companyContext.isMaster,
    companyRoleOverride: opts.companyRoleOverride,
    // Attribute terminal delivery assessments and deterministic incidents to
    // the owning Company run. Null for individual coder sessions.
    companyAgentRunId: opts.companyContext?.agentRunId ?? null,
    companySessionId: opts.companyContext?.companySessionId ?? null,
    adminOverride: opts.adminOverride,
    agentId: effectiveAgentId,
    sessionTemperature: session.temperature_override,
    roleTemperature: opts.roleTemperature,
    // Reasoning-effort override (orthogonal to thinking). `ultra` remains an
    // internal product marker here; the provider-factory wrapper maps it to
    // the active model's highest supported native level or omits it entirely.
    reasoningEffort: effectiveReasoningEffort,
    // Per-session tool-output cap LEVEL (migration 153; falls back to the legacy
    // migration-078 boolean → 'max'). Scales the per-block PUSH_TIME_CAP and the
    // MCP/code_exec/read_file caps so verbose tools (Unity, large reads, batched
    // code_exec) arrive intact.
    toolOutputCapLevel:
      parseToolOutputCapLevel(session.tool_output_cap_level) ??
      levelFromLegacyBoolean(session.unrestricted_tool_output),
    // Tool permission mode (migration 131) — resolved once at the system-prompt
    // call site so the prompt's permissions block and this gate agree.
    toolPermissionMode: resolvedPermissionMode,
    // The host snapshot is immutable for the attempt. Explicit test/in-process
    // tunables remain the highest-precedence compatibility override.
    tunables: opts.tunables ?? (opts.runtimePolicy
      ? tunablesFromRuntimePolicy(opts.runtimePolicy)
      : undefined),
    runtimePolicy: opts.runtimePolicy,
    // Stateful Responses API resume — populated only for ChatGPT/Codex sessions
    // that completed at least one turn with `store: true`. Other providers
    // ignore these fields.
    previousResponseId: session.last_response_id,
    previousResponseMessageCount: session.last_response_message_count,
    onResponseId: (responseId, messageCount) => {
      try {
        store.setLastResponseState(session.id, responseId, messageCount);
      } catch (e) {
        console.warn(
          `[coder] setLastResponseState failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    agentLoopV2,
  });

  // A runCoder invocation owns one CoderRunner, but that runner can execute
  // many internal model turns. If the three-minute first-turn gate timed out,
  // the baseline may become ready while this exact runner is still alive. Do a
  // cheap live readiness read at turn boundaries until it succeeds, then
  // atomically promote both the shared ToolContext and the prompt once. The
  // registry is intentionally untouched and no reconciliation/full scan is
  // scheduled here.
  if (!isIndexed) {
    let indexContextPromoted = false;
    runner.on('turn_start', () => {
      if (indexContextPromoted) return;
      try {
        const liveProject = db.getProject(project.id) as (typeof project & {
          file_count?: number | null;
          structural_indexed_at?: string | null;
          last_indexed?: string | null;
        }) | undefined;
        const liveStats = db.getStats(project.id);
        const liveFileCount = liveProject?.file_count ?? liveStats?.file_count ?? 0;
        const structurallyReady = liveFileCount > 0
          && Boolean(liveProject?.structural_indexed_at || liveProject?.last_indexed);
        if (!structurallyReady) return;

        toolContext.projectIndexed = true;
        indexStatus.isIndexed = true;
        const liveRepoMapBudget = resolveRepoMapBudget(db, project.id, true);
        const liveRepoMap = liveRepoMapBudget > 0
          ? buildRepoMap(db, project.id, liveRepoMapBudget)
          : '';
        promptContext.isIndexed = true;
        promptContext.repoMap = liveRepoMap;
        systemPrompt = promoteIndexReadySystemPrompt(systemPrompt, {
          mcpAvailable: promptContext.mcpAvailable,
          sessionDrive: promptContext.sessionDrive,
          availableTools,
          repoMap: liveRepoMap,
        });
        runner.setSystemPromptForNextTurn(systemPrompt);
        indexContextPromoted = true;
      } catch (e) {
        // A transient read race must not affect the model turn. Keep polling at
        // later boundaries until the persisted baseline can be observed.
        console.warn(
          `[coder] live structural readiness refresh failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
  }

  // A migrated legacy bundle may still carry the old todos shadow in
  // session.json. Fold it once into the filesystem task board when no board
  // exists; the board is then the sole source of truth.
  if (session.todos_json && !tasksStateCache) {
    try {
      const parsed = JSON.parse(session.todos_json) as Array<Partial<TodoItem>>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const hydrated: TodoItem[] = parsed.map((t) => ({
          id: typeof t.id === 'string' && t.id.length >= 6 ? t.id : generateTodoId(),
          content: typeof t.content === 'string' ? t.content : '',
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : '',
          status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
        }));
        const row = await store.recordTasks({
          session_id: session.id,
          tool_use_id: `track_migrate_${session.id}`,
          state: buildTrackState(hydrated),
        });
        tasksStateCache = row.state;
      }
    } catch (e) {
      console.warn(`[coder] failed to migrate todos_json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Persist todos on every `todos_updated` event and re-emit nothing else.
  runner.on('todos_updated', ({ todos }) => {
    void store
      .setSessionTodos(session.id, JSON.stringify(todos))
      .catch((e) => {
        console.warn(`[coder] setSessionTodos failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  });

  // Session-start worktree: when the caller passes `opts.worktree` AND the
  // session does not already have one persisted, create the worktree now
  // and scope the runner into it before the first turn. This is the primary
  // path — users decide "run in an isolated worktree" once, at creation,
  // instead of having the agent figure it out mid-run via the admin tool.
  let worktreePreparationError: unknown;
  if (opts.worktree && !session.worktree_path) try {
    const created = await createProjectWorktree(resolvePath(project.root_path), opts.worktree,
      { signal: opts.signal, shell: toolContext.ports?.shell, runtimeEnv: toolContext.runtimeEnv });
    if (created.ok) {
      runner.enterWorktreeScope(created.path);
      try {
        await store.setSessionWorktree(session.id, created.path);
      } catch (e) {
        throw new Error(`Worktree was created at ${created.path}, but its session setting could not be saved. The directory was preserved.`, { cause: e });
      }
      console.log(`[coder] session ${session.id} started in worktree ${created.path} (branch ${created.branch})`);
    } else {
      throw new Error(`Requested session worktree could not be prepared: ${created.error}`);
    }
  } catch (cause) {
    // Surface preparation failure through the normal done/finally boundary so
    // owned MCP connections and output writers are drained before returning.
    worktreePreparationError = cause;
  }

  // Rehydrate the worktree scope on session resume. If the DB says this
  // session was inside a worktree when the server stopped, put the runner
  // back there before the first turn runs so tool calls see the right cwd.
  if (session.worktree_path) try {
    const checkout = await resolveProjectWorktree(originalProjectRoot, session.worktree_path);
    if (checkout && !runner.worktreePath) runner.enterWorktreeScope(checkout, originalProjectRoot);
  } catch (cause) {
    // Never silently redirect a worktree conversation into the main checkout.
    // Keep the binding so restoring the directory makes the session resumable.
    worktreePreparationError = new Error(`Session worktree is unavailable: ${session.worktree_path}. Restore the checkout before continuing.`, { cause });
  }

  // Persist worktree enter/exit so a server restart can resume in the same cwd.
  runner.on('worktree_entered', ({ path }) => {
    try {
      store.setSessionWorktree(session.id, path);
    } catch (e) {
      console.warn(`[coder] setSessionWorktree (enter) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  runner.on('worktree_exited', () => {
    try {
      store.setSessionWorktree(session.id, null);
    } catch (e) {
      console.warn(`[coder] setSessionWorktree (exit) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  if (!opts.resume) {
    // Prepend the send-time IDE context (active file / selections / open tabs)
    // as a structured <ide_context> block so the agent sees the editing focus.
    // Only on a fresh send — it's a snapshot, not re-injected every turn.
    const ideBlock = formatIdeContext(opts.ideContext);
    const messageText = ideBlock ? `${ideBlock}\n\n${opts.userMessage}` : opts.userMessage;
    const userBlocks = attachmentsToBlocks(messageText, opts.attachments);
    const pickExtras =
      opts.selectedSkillIds && opts.selectedSkillIds.length > 0
        ? { selectedSkillIds: opts.selectedSkillIds }
        : undefined;
    const roundMessageId = await store.appendMessage({
      session_id: session.id,
      message: {
        role: 'user',
        content: userBlocks,
        ...(pickExtras ?? {}),
      },
    });
    runner.pushUserContent(userBlocks, { ...(pickExtras ?? {}), roundMessageId });
  } else {
    // Resume: tool_result was already appended to the DB by the API handler.
    // It is already part of initialMessages → runner.messages, so the
    // turn_start flush below must skip it. The submit_plan handler that
    // produced this resume path also calls approvePlan() inline; we need to
    // re-apply that here so the runner accepts mutating tools.
    //
    // Scan the recent tail (not just the last message): the OFFLINE plan-approval
    // path appends a "Mode transition" reminder AFTER the "Plan approved" tool
    // result, which would otherwise hide it. Walk back to the most recent plan
    // verdict — a later rejection/abort must NOT be overridden by an older approval.
    const latestPersistedUser = [...(existingEarly?.message_rows ?? [])]
      .reverse()
      .find((row) => row.role === 'user' && !row.is_meta);
    runner.setRoundMessageId(latestPersistedUser?.seq ?? null);
    for (let i = runner.messages.length - 1, seen = 0; i >= 0 && seen < 6; i--) {
      const m = runner.messages[i];
      if (m.role !== 'tool') continue;
      seen++;
      let verdict: 'approved' | 'rejected' | null = null;
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        if (/Plan approved by user/.test(b.content)) { verdict = 'approved'; break; }
        if (/Plan (rejected|review aborted) by user/.test(b.content)) { verdict = 'rejected'; break; }
      }
      if (verdict === 'approved') runner.approvePlan();
      if (verdict) break;
    }
  }
  store.updateSessionStatus(session.id, 'running');

  // Persist assistant messages and tool results as the runner emits them.
  // We need to map tool_call_results back to the message they belong to,
  // Per-turn buffer: accumulate assistant message + all its tool results, then
  // flush to the per-session journal as one turn commit. Artifacts are committed
  // first, so a crash cannot leave a confirmed reference to a missing payload.
  const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

  interface PendingTurn {
    message: AgentMessage;
    usage: ChatUsage | null;
    context?: PromptContextMeasurement;
    toolCalls: Array<{
      tool_use_id: string;
      tool_name: string;
      args: Record<string, unknown>;
      result_text: string;
      effect_outcome?: 'unknown';
      is_error: boolean;
      duration_ms: number;
      output_chars: number;
      /**
       * Size the LLM actually saw (post reduce+cap). Set in the
       * `tool_call_result` handler from result.content.length; pair with
       * output_chars (raw) to compute savings.
       */
      output_chars_shaped: number | null;
      output_format?: 'text' | 'markdown' | 'json' | null;
      structured_output_chars?: number | null;
      truncated: boolean;
      /**
       * Harness refusal tag (gate/pre-read/task-mode/dedup/user_denied/
       * failure-streak/timeout/abort) from the dispatch pipeline; null on a
       * real invocation. messages.ts falls back to classifyToolRefusal for
       * rows that arrive without it (legacy/subagent paths).
       */
      refusal_kind: string | null;
      turn_telemetry_id: string | null;
      /** Set on nested (code_exec script) rows only — links to the parent block. */
      parent_tool_use_id?: string | null;
      reduction_kind?: string | null;
      reduction_technique?: string | null;
      reduction_meta_json?: string | null;
      output_id?: string | null;
      run_id?: string | null;
      parent_run_id?: string | null;
      is_subagent?: boolean;
      subagent_profile?: string | null;
      logical_operation_id?: string | null;
      productive?: boolean | null;
      guard_action?: 'allow' | 'reuse' | 'warn' | 'block' | 'shadow' | null;
      guard_reason?: string | null;
      would_block?: boolean | null;
      state_epoch?: number | null;
      result_novel?: boolean | null;
      coverage_novel?: boolean | null;
      delivered?: boolean | null;
      repeat_policy?: 'stable' | 'volatile' | 'pollable' | 'mutating' | null;
      execution_class?: 'read' | 'write' | 'execute' | 'control' | null;
      guard_origin_tool_use_id?: string | null;
    }>;
    /**
     * Nested code_exec invocations buffered from `nested_tool_call` events.
     * Persisted as audit-only rows (parent_tool_use_id set) — NEVER part of
     * the paired tool message (no matching tool_use block exists for them).
     */
    nestedToolCalls: PendingTurn['toolCalls'];
    /** Stable idempotency identity for this assistant message within the run. */
    operationId: string;
    subagentUsage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
    /**
     * In-flight checkpoint (set by `awaiting_input` when the turn parks on
     * waitForUserInput). `promise` resolves when the assistant message has been
     * durably written; `messageId` is that row's id so the eventual flush
     * COMPLETES it (existing_message_id) instead of inserting a duplicate.
     * Stored on the turn itself — discarded with the buffer — so concurrent
     * turns can never clobber each other's checkpoint state.
     */
    checkpoint?: { promise: Promise<void>; messageId: number | null };
  }
  let pendingTurn: PendingTurn | null = null;

  const flushPendingTurn = (): Promise<void> => {
    // Detach the buffer synchronously. EventEmitter callers intentionally do
    // not await this function; capturing here prevents the next message_complete
    // from replacing the turn before its queued DB write starts.
    if (!pendingTurn) return flushChain;
    const turn = pendingTurn;
    pendingTurn = null;
    // Captured synchronously so a later turn's telemetry cannot cross-stamp
    // this one. The bundle metric promise is awaited inside `persist`.
    const telemetryId = runner.lastTurnTelemetryId;
    const persist = async (): Promise<void> => {
    // If this turn was checkpointed while awaiting input (see `awaiting_input`),
    // wait for that write to settle and reuse its row id so we COMPLETE (not
    // duplicate) the assistant message. State lives on `turn`, so a later turn's
    // checkpoint cannot clobber ours across this await.
    if (turn.checkpoint) {
      try { await turn.checkpoint.promise; } catch { /* fall back to fresh insert */ }
    }
    // Diagnostic telemetry is best effort. A slow metric write must not hold
    // the authoritative transcript barrier or the next provider turn. Stamp an
    // identity only when it was already available at this turn boundary.
    const resolvedTelemetryId = telemetryId;
    if (resolvedTelemetryId != null) {
      for (const tc of turn.toolCalls) tc.turn_telemetry_id = resolvedTelemetryId;
      for (const tc of turn.nestedToolCalls) tc.turn_telemetry_id = resolvedTelemetryId;
    }
    const hasSubUsage = turn.subagentUsage.input_tokens > 0
      || turn.subagentUsage.output_tokens > 0;
    const payload = {
      session_id: session.id,
      operation_id: `${turn.operationId}:commit`,
      message: turn.message,
      usage: turn.usage,
      context: turn.context,
      tool_calls: turn.toolCalls,
      nested_tool_calls: turn.nestedToolCalls.length > 0 ? turn.nestedToolCalls : undefined,
      subagent_usage: hasSubUsage ? turn.subagentUsage : undefined,
      // Reuse the checkpointed assistant row (if the write succeeded) so the
      // tool rows + paired tool message attach to it rather than a duplicate.
      existing_message_seq: turn.checkpoint?.messageId ?? undefined,
    };
    try {
      await measureStorage('tool-output.drain', () => toolOutputStore.drain());
      await measureStorage('assistant.persist', () => store.persistAssistantTurn(payload));
      if (turn.toolCalls.some(call => call.effect_outcome === 'unknown')) {
        // Recovery evidence is additive. A failed receipt commit leaves the
        // original incident pending; it never invalidates the transcript.
        try { await outcomeRecovery.historyCommitted(); }
        catch (error) { console.warn('[coder] outcome recovery remains pending:', error instanceof Error ? error.message : String(error)); }
      }
    } catch (err) {
      // The filesystem journal is authoritative; the SSE bus is volatile and
      // cannot reconstruct a turn after Electron exits. Fail closed so the
      // persistence barrier stops the next provider/tool turn instead of
      // showing content that will disappear on restart.
      const failure = err instanceof Error ? err : new Error(String(err));
      criticalTranscriptPersistenceError ??= failure;
      console.error(`[coder] persistAssistantTurn failed for session ${session.id}:`, failure);
      throw failure;
    }
    };
    // Preserve assistant/tool row order and let a compaction checkpoint await
    // every earlier fire-and-forget flush before reading the visible DB span.
    const queuedAt = performance.now();
    const previousFlush = flushChain;
    const run = () => {
      recordStorageElapsed('transcript.queue', queuedAt);
      return persist();
    };
    const scheduled = traceStorageOperation({ sessionId: session.id, operationId: turn.operationId },
      () => previousFlush.then(run, run));
    flushChain = scheduled.catch(() => undefined);
    return scheduled;
  };

  // Recovery must commit nested identities before admitting another turn:
  // a different wrapper script must not replay the same uncertain child call.
  toolContext.commitToolOutcomeRecovery = async () => {
    await flushPendingTurn();
    if (criticalTranscriptPersistenceError) throw criticalTranscriptPersistenceError;
    await outcomeRecovery.historyCommitted();
  };

  // Durably persist JUST the assistant message of the turn that is about to
  // block on user input. Non-destructive: `pendingTurn` stays live so the
  // tool_result that arrives after approval still buffers and the eventual
  // flushPendingTurn completes the row. tool_calls:[] → no paired tool message
  // is written yet; usage:null → no usage bump (both happen at the real flush).
  const checkpointPendingTurn = (): void => {
    const turn = pendingTurn;
    // One checkpoint per turn (a turn can hit multiple permission pauses).
    if (!turn || turn.checkpoint) return;
    // Only checkpoint turns the resume path can restore as an interactive card.
    if (!hasResumableInteractiveToolUse(turn.message)) return;
    const cp: { promise: Promise<void>; messageId: number | null } = {
      promise: Promise.resolve(),
      messageId: null,
    };
    turn.checkpoint = cp;
    cp.promise = (async () => {
      const payload = {
        session_id: session.id,
        operation_id: `${turn.operationId}:checkpoint`,
        message: turn.message,
        usage: null,
        context: turn.context,
        tool_calls: [],
      };
      try {
        await toolOutputStore.drain();
        cp.messageId = await store.persistAssistantTurn(payload);
      } catch (err) {
        // A parked interaction has no following turn_start barrier. Mark the
        // durability failure critical and abort the volatile wait so shutdown
        // cannot silently discard the pending assistant/tool_use message.
        turn.checkpoint = undefined;
        const failure = err instanceof Error ? err : new Error(String(err));
        criticalTranscriptPersistenceError ??= failure;
        console.error(`[coder] checkpointPendingTurn failed for session ${session.id}:`, failure);
        try { runner.abort(); } catch { /* best-effort terminalization */ }
      }
    })();
  };
  runner.on('awaiting_input', () => { checkpointPendingTurn(); });

  runner.on('tool_call_start', (id, name, input) => {
    pendingToolCalls.set(id, { name, input });
  });

  let completionFinalText: string | null = null;
  runner.on('user_message_boundary', () => { completionFinalText = null; });
  runner.on('message_complete', (message, usage, operationId, context) => {
    if (message.role === 'assistant' && message.phase !== 'commentary' && !message.content.some(block => block.type === 'tool_use')) {
      completionFinalText = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 16000) || null;
    }
    if (message.role !== 'assistant') return;
    // A new assistant message replaces any prior buffered turn that had no
    // tool calls (e.g., a pure-text turn). Persist the prior one first.
    flushPendingTurn();
    pendingTurn = {
      message,
      operationId,
      usage: usage ?? null,
      context,
      toolCalls: [],
      nestedToolCalls: [],
      subagentUsage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });

  // Nested code_exec invocations — one row per settled script call, linked
  // to the parent block via parent_tool_use_id (mig 133). Buffered into the
  // same per-turn flush so the audit lands atomically with the turn.
  runner.on('nested_tool_call', (e) => {
      try {
        if (!pendingTurn) return;
        pendingTurn.nestedToolCalls.push({
          // Every nested row uses the invocation-order identity captured
          // before concurrent work starts. Completion order can invert (for
          // example, a fast guard refusal beside a slow shell call), so mixing
          // it with guard origin ids can produce duplicate tool_use_id values.
          tool_use_id: nestedToolCallUseId(e),
          ...(e.effectOutcome ? { effect_outcome: e.effectOutcome } : {}),
          tool_name: e.name,
          args: e.args,
          result_text: e.resultPreview,
          is_error: e.isError,
          duration_ms: e.durationMs,
          output_chars: e.resultChars,
          output_chars_shaped: null,
          output_format: 'text',
          structured_output_chars: null,
          truncated: (e.sourceTruncations?.length ?? 0) > 0,
          refusal_kind: e.refusalKind ?? null,
          turn_telemetry_id: null,
          parent_tool_use_id: e.parentToolUseId,
          reduction_kind: e.sourceTruncations?.length ? 'source_cap' : null,
          reduction_technique: e.sourceTruncations?.[0]?.technique ?? null,
          reduction_meta_json: e.sourceTruncations?.length
            ? JSON.stringify({ sourceTruncations: e.sourceTruncations })
            : null,
          output_id: null,
          run_id: runner.runId,
          parent_run_id: null,
          is_subagent: false,
          subagent_profile: null,
          logical_operation_id: e.logicalOperationId ?? null,
          productive: e.productive ?? null,
          guard_action: e.guardVerdict?.action ?? null,
          guard_reason: e.guardVerdict?.reason ?? null,
          would_block: e.guardVerdict?.wouldBlock ?? null,
          state_epoch: e.stateEpoch ?? e.guardVerdict?.stateEpoch ?? null,
          result_novel: e.resultNovel ?? null,
          coverage_novel: e.coverageNovel ?? null,
          delivered: e.delivered ?? null,
          repeat_policy: e.repeatPolicy ?? null,
          execution_class: e.executionClass ?? null,
          guard_origin_tool_use_id: e.guardVerdict?.originToolUseId ?? null,
        });
      } catch { /* telemetry must never break the run */ }
    });

  runner.on('tool_call_result', (id, name, result, durationMs) => {
    // Error-streak tracker for auto-captured "Fixed: <tool>" notes. Cheap,
    // best-effort, and independent of the telemetry buffering below.
    const capturedMilestone = autoCapture.onToolResult(
      name,
      Boolean(result.isError),
      result.isError ? String(result.content ?? '').slice(0, 200) : '',
      runnerRef?.turn ?? 0,
      result.ledgerEntry?.logicalOperationId,
    );
    if (capturedMilestone) runnerRef?.requestMilestoneCompaction('milestone:error-resolved');
    if (!pendingTurn) return;
    const pending = pendingToolCalls.get(id);
    const content = result.content ?? '';
    pendingTurn.toolCalls.push({
      tool_use_id: id,
      tool_name: name,
      // Harness-refused calls (gate/pre-read/dedup/…) never fired
      // tool_call_start, so there is no pending entry — the result event
      // carries the original input precisely for this row.
      args: pending?.input ?? result.input ?? {},
      result_text: content,
      ...(result.effectOutcome ? { effect_outcome: result.effectOutcome } : {}),
      is_error: Boolean(result.isError),
      duration_ms: durationMs,
      // output_chars = RAW tool output (pre-reduce, from result.rawChars);
      // output_chars_shaped = what the LLM saw (post reduce+cap = content).
      // Savings = output_chars - output_chars_shaped. Synthetic refusals carry
      // no rawChars → raw==shaped (savings 0). Both sourced from this single
      // event (the old tool_call_finalized stamp raced and never landed).
      output_chars: result.rawChars ?? content.length,
      output_chars_shaped: content.length,
      output_format: result.contentFormat ?? 'text',
      structured_output_chars: result.structuredOutputChars ?? null,
      truncated: hasStructuredToolTruncation(result),
      refusal_kind: result.refusalKind ?? null,
      reduction_kind: result.reductionReport?.kind
        ?? (result.sourceTruncations?.length ? 'source_cap' : null),
      reduction_technique: result.reductionReport?.technique
        ?? result.sourceTruncations?.[0]?.technique
        ?? null,
      reduction_meta_json: result.reductionReport
        ? JSON.stringify(result.reductionReport)
        : result.sourceTruncations?.length
          ? JSON.stringify({ sourceTruncations: result.sourceTruncations })
          : null,
      output_id: result.outputId ?? result.reductionReport?.outputId ?? null,
      run_id: runner.runId,
      parent_run_id: null,
      is_subagent: false,
      subagent_profile: null,
      logical_operation_id: result.ledgerEntry?.logicalOperationId ?? null,
      productive: result.ledgerEntry?.productive ?? null,
      guard_action: result.guardVerdict?.action ?? null,
      guard_reason: result.guardVerdict?.reason ?? null,
      would_block: result.guardVerdict?.wouldBlock ?? null,
      state_epoch: result.stateEpoch ?? result.guardVerdict?.stateEpoch ?? null,
      result_novel: result.ledgerEntry?.resultNovel ?? null,
      coverage_novel: result.ledgerEntry?.coverageNovel ?? null,
      // tool_call_result is emitted only after the block has been appended to
      // model history; unlike nested siblings, delivery is unambiguous here.
      delivered: true,
      repeat_policy: (result.ledgerEntry?.repeatPolicy as PendingTurn['toolCalls'][number]['repeat_policy']) ?? null,
      execution_class: (result.ledgerEntry?.executionClass as PendingTurn['toolCalls'][number]['execution_class']) ?? null,
      guard_origin_tool_use_id: result.guardVerdict?.originToolUseId ?? null,
      // Stamped at flushPendingTurn time, when persistTurnTelemetry has
      // already run for this turn and runner.lastTurnTelemetryId is the
      // id of THIS turn's row. Setting it here would point at the prior turn.
      turn_telemetry_id: null,
    });
    // Accumulate subagent usage for this turn — flushed with the transaction
    // so dashboard cost totals can never show partial spend.
    if (result.subUsage) {
      pendingTurn.subagentUsage.input_tokens += result.subUsage.input_tokens;
      pendingTurn.subagentUsage.output_tokens += result.subUsage.output_tokens;
      pendingTurn.subagentUsage.cache_read_input_tokens += result.subUsage.cache_read_input_tokens ?? 0;
      pendingTurn.subagentUsage.cache_creation_input_tokens += result.subUsage.cache_creation_input_tokens ?? 0;
    }
    pendingToolCalls.delete(id);
  });

  // output_chars_shaped is set directly in the `tool_call_result` handler
  // above (from result.content.length). The old `tool_call_finalized` DB stamp
  // raced the result event — finalized fired during dispatch, before the
  // tool_call_result row existed — so it never landed (100% NULL). The
  // `tool_call_finalized` event still fires for the live dashboard badge.

  // Persist the buffered assistant turn at each turn boundary.
  // `persistAssistantTurn` commits the assistant message, tool-call metadata,
  // outputs and paired tool message as one filesystem turn, so there is no
  // separate tool-message flush to keep in sync. The previous approach scanned
  // `runner.messages` from an integer
  // cursor, which raced compaction: the Compacting node reassigns
  // `ctx.messages` to a new, shorter array, leaving the cursor past its end so
  // the scan silently stopped persisting tool messages for the rest of the run
  // (session 969: ~38 turns of tool results lost while the audit rows survived).
  runner.on('turn_start', () => {
    void flushPendingTurn();
  });

  // Capture the last error emitted by the runner so we can propagate it
  // through the done promise. The runner emits `done('error', Error)` but
  // `run()` returns `{ reason: 'error' }` without the Error — this bridges that gap.
  let lastRunnerError: Error | undefined;
  runner.on('done', (_reason: string, error?: Error) => { lastRunnerError = error; });

  // One-call durable compaction. CompactingNode hands us the exact V3 object
  // it already injected in memory; after flushing the pending assistant/tool
  // pair we align that summarized head with the visible bundle prefix and
  // append the chapter checkpoint. There is no history_compacted-triggered
  // second summarization anymore.
  const commitDurableCheckpoint = async (
    checkpoint: CompactionCheckpoint,
  ): Promise<CompactionCheckpointResult> => {
    if (!durableCompactionEnabled() || runner.isSubagent || session.id == null) {
      return { status: 'disabled' };
    }
    try {
      return await serializeSessionCompaction(session.id, async () => {
        await flushPendingTurn();
        const committed = await persistChapterCheckpoint({
          store,
          sessionId: session.id,
          summary: checkpoint.summary,
          headMessages: checkpoint.headMessages,
          source: 'auto',
          chapterKind: checkpoint.trigger?.startsWith('milestone:') ? 'milestone' : 'context',
          trigger: checkpoint.trigger ?? 'context_threshold',
          chaptersEnabled: true,
          autoContinues: checkpoint.autoContinues,
        });
        const accepted = committed.status === 'committed'
          || committed.status === 'compatibility'
          || (committed.status === 'noop' && committed.reason === 'already_committed');
        if (!accepted) {
          return {
            status: committed.status === 'noop' ? 'noop' : 'failed',
            boundaryId: committed.boundary_seq,
            reason: committed.status === 'noop' ? committed.reason : 'checkpoint rejected',
          };
        }
        if (opts.runEndMemory) {
          // Reuse the same paid V3 summary. Harvest is best-effort and does not
          // delay the model loop after the atomic chapter commit succeeds.
          void harvestCompactionMemory({
            runEndMemory: opts.runEndMemory,
            store,
            getMemoryEnabled: () => db.getProjectMemoryEnabled(memoryWriteProjectId),
            projectId: project.id,
            projectName: project.name,
            sessionId: session.id,
            summary: summaryV3ToV2(checkpoint.summary),
            boundaryId: committed.boundary_seq,
            sourceStartSeq: 'chapter' in committed ? committed.chapter?.start_message_seq : undefined,
            trigger: 'compaction',
          });
        }
        return {
          status: committed.status === 'compatibility' ? 'compatibility' : 'committed',
          chapterId: 'chapter' in committed ? committed.chapter?.id ?? null : null,
          boundaryId: committed.boundary_seq,
        };
      });
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const checkpointCoordinator = new DurableCheckpointCoordinator(commitDurableCheckpoint, {
    maxAttempts: 3,
    baseBackoffTurns: 2,
    executeRetry: async (checkpoint, _attempt, commit) => {
      const chars = checkpoint.headMessages.reduce((total, message) => {
        try { return total + JSON.stringify(message.content).length; } catch { return total; }
      }, 0);
      const attemptId = await store.startCompactionAttempt({
        session_id: session.id,
        run_id: runner.runId,
        turn: runner.turn,
        turn_telemetry_id: runner.lastTurnTelemetryId,
        trigger: `checkpoint_retry:${checkpoint.trigger ?? 'context_threshold'}`,
        provider_chain: [],
        prompt_tokens_before: Math.ceil(chars / 4),
        history_chars_before: chars,
      });
      const retried = await commit(checkpoint);
      await store.finishCompactionAttempt(session.id, attemptId, {
        status: retried.status === 'committed' || retried.status === 'compatibility'
          ? 'summarized'
          : retried.status === 'disabled'
            ? 'noop'
            : 'checkpoint_failed',
        strategy: 'summarizer',
        summarizer_ran: false,
        history_chars_after: chars,
        chapter_id: retried.chapterId ?? null,
        boundary_seq: retried.boundaryId ?? null,
        error_message: retried.reason ?? null,
      });
      return retried;
    },
  });
  runner.setCompactionCheckpointHandler((checkpoint) => (
    checkpointCoordinator.submit(checkpoint, runner.turn)
  ));
  // Only transient storage failures remain pending. Retry at most twice after
  // exponential turn backoff; alignment no-ops wait for a newer checkpoint to
  // rebase the durable head instead of replaying an immutable bad snapshot.
  runner.on('turn_start', () => {
    if (checkpointCoordinator.hasPending) void checkpointCoordinator.retry(runner.turn);
  });

  // Phase-route skip summary handler removed along with PhaseRouter.

  // Fire the caller's pre-run hook so they can attach listeners that
  // must observe the FIRST turn. Critical for company HumanInTheLoop
  // (`question_posted` from a master that calls `ask_user` on turn 1).
  // See `RunCoderOptions.onRunnerReady` for the contract.
  if (opts.onRunnerReady) {
    opts.onRunnerReady(runner);
  }

  // Permission gate — pauses write/execute/admin tool calls for user
  // approval depending on the session mode. Lives on the SHARED toolContext
  // object (the runner holds the same reference), so the main dispatch,
  // code_exec nested calls and subagent context copies all consult ONE
  // instance. Mode is read live from the runner, so PATCH
  // /tool-permission-mode applies mid-run to the next gated call.
  {
    let initialGrants: string[] = [];
    try {
      const parsed: unknown = JSON.parse(session.tool_permission_grants ?? '[]');
      if (Array.isArray(parsed)) initialGrants = parsed.filter((g): g is string => typeof g === 'string');
    } catch { /* corrupted grants column — start empty */ }
    toolContext.permissionGate = new PermissionGate({
      getMode: () => runner.getToolPermissionMode(),
      emit: (event, payload) => { runner.emit(event, payload as never); },
      waitForUserInput: (askId) => runner.waitForUserInput(askId),
      resolvePending: (askId, value) => runner.provideUserInput(value, askId),
      initialGrants,
      onGrant: (toolName) => {
        try {
          store.addToolPermissionGrant(session.id, toolName);
        } catch (e) {
          console.warn(`[coder] addToolPermissionGrant failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      // Keep-alive while approvals are pending so the stuck-running
      // watchdog (10 min) doesn't flip the session to idle mid-pause.
      onPendingTick: () => {
        try { store.touchSession(session.id); } catch { /* best-effort */ }
      },
    });
  }

  // Close the recorder ↔ runner loop now that both exist. The recorder
  // reads `runnerRef?.turn` lazily so writes captured inside `runner.run()`
  // are stamped with the right turn number.
  runnerRef = runner;

  // Durable-memory write-back now rides the compaction summary (see the
  // `history_compacted` handler above) and the idle sweeper (http-api) —
  // both reuse summaries that are already paid for, replacing the old
  // per-run-end capture that burned an extra summarizeSpanV2 on every run.

  type RunOutcome = { reason: string; usage: ChatUsage; error?: string };
  let resolveTranscriptFlushed!: (outcome: RunOutcome) => void;
  let rejectTranscriptFlushed!: (error: unknown) => void;
  const transcriptFlushed = new Promise<RunOutcome>((resolve, reject) => {
    resolveTranscriptFlushed = resolve;
    rejectTranscriptFlushed = reject;
  });
  // Most in-process consumers only await `done`; keep a rejected persistence
  // boundary from becoming an unhandled rejection when no transport observes
  // the earlier promise.
  void transcriptFlushed.catch(() => undefined);

  if (collaboration) await collaboration.store.files.put('policies', session.id, ultraPreset);
  const closeChatMailbox = collaboration
    ? await attachChatMailbox(collaboration.store, collaboration.participant, runner)
    : undefined;
  let companyReservation: string | undefined;
  const donePromise = Promise.resolve()
    .then(async () => {
      if (worktreePreparationError) throw worktreePreparationError;
      if (opts.admitAttempt) {
        if (!opts.controlPlaneParentAgentRunId) throw new Error('Attempt admission requires the owning AgentRun');
        const preparation = prepareCoderAttempt({
          sessionId: session.id,
          agentRunId: asAgentRunId(opts.controlPlaneParentAgentRunId),
          runnerRunId: runner.runId,
          provider: session.provider, model: session.model,
          reasoningEffort: effectiveReasoningEffort ?? undefined,
          agentDefinitionId: opts.agentSelectionId ?? effectiveAgentId ?? 'code-agent/default',
          systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'),
          capabilityProfile: preResolvedProfile,
          environment: { kind: sandboxBinding ? 'container' : runner.worktreePath ? 'worktree' : 'host', cwd: runner.worktreePath ?? toolContext.cwd },
          policy: { permissionMode: resolvedPermissionMode, planMode: !!opts.planMode,
            specMode: opts.specMode ?? (effectiveAgentId === 'spec'), runtime: opts.runtimePolicy },
        }, registry, catalogOnlyCapabilities);
        const admission = await admitCoderAttempt(preparation, opts.admitAttempt, opts.signal);
        toolContext.invocation = {
          version: 2, invocationId: randomUUID(), toolId: 'agent_attempt',
          owner: { kind: 'agent', sessionId: session.id, runId: admission.agentRunId, attemptId: admission.attemptId },
          projectId: toolContext.projectId, catalogRevision: preparation.capabilitySet.hash,
          authorizationRevision: String(admission.fencingEpoch),
          cancellationId: admission.attemptId, traceId: admission.agentRunId,
        };
      }
      opts.signal?.throwIfAborted();
      if (opts.companyContext && !opts.companyContext.isMaster && sharedBudget) {
        const id = `company:${runner.runId}`;
        await sharedBudget.reserve(id, session.id);
        companyReservation = id;
        await sharedBudget.bind(id, session.id, runner.runId);
      }
      const running = runner.run();
      if (collaboration && opts.userMessage) {
        // The runner was admitted through the normal host policy before this
        // optional UI receipt. Failure must never launch/replay another run.
        const receipt = new CollaborationFollowups(collaboration.store.files).observeStarted(session.id, runner.runId, opts.userMessage)
          .catch(error => console.warn('[ultra] proposal start receipt failed', error));
        return (await Promise.all([running, receipt]))[0];
      }
      return running;
    })
    .catch((error: unknown) => {
      // Stop during admission is a cancellation with zero provider usage.
      // A concurrent disk/authority error remains an error, even after Stop.
      if (opts.signal?.aborted && error === opts.signal.reason) {
        return { reason: 'aborted' as const, totalUsage: { input_tokens: 0, output_tokens: 0 } };
      }
      throw error;
    })
    .then(async (res) => {
      await flushPendingTurn();
      if (criticalTranscriptPersistenceError) {
        throw criticalTranscriptPersistenceError;
      }
      store.updateSessionStatus(session.id, res.reason === 'error' ? 'error' : 'idle');
      const outcome: RunOutcome = {
        reason: res.reason,
        usage: res.totalUsage,
        error: lastRunnerError?.message,
      };
      if (collaboration) await collaboration.store.recordCompletion({
        sessionId: session.id, runId: runner.runId, reason: res.reason, at: Date.now(), finalText: completionFinalText,
      });
      if (companyReservation && sharedBudget) {
        const confirmed = !toolContext.toolCallLedger?.outcomeUnknownTool && !toolContext.outcomeRecovery?.toolUseIds.length;
        await budgetFiles.insert('checkpoints', `budget-receipt:${sharedBudget.rootId}:${companyReservation}`, { runId: runner.runId, confirmed });
        await sharedBudget.settle(companyReservation, 0, 0, !confirmed);
      }
      // The SSE terminal event must not race the final DB writer. Expose this
      // earlier lifecycle boundary so the worker can close the stream only
      // after a transcript refetch is guaranteed to see the terminal turn.
      resolveTranscriptFlushed(outcome);
      await checkpointCoordinator.retry(runner.turn, true);
      return outcome;
    })
    .catch(async (e) => {
      if (companyReservation && sharedBudget) await sharedBudget.settle(companyReservation, 0, 0, true);
      // A provider/runner failure may arrive while the final assistant turn is
      // still buffered. If that flush also fails, persistence is the stronger
      // terminal error; either way the public durability promise MUST settle
      // so deferred SSE/Company consumers cannot hang forever.
      let terminalError: unknown = e;
      try {
        await flushPendingTurn();
      } catch (persistError) {
        terminalError = persistError;
      }
      try {
        await store.updateSessionStatus(session.id, 'error');
        if (collaboration) await collaboration.store.recordCompletion({
          sessionId: session.id, runId: runner.runId, reason: 'error', at: Date.now(),
        });
      } catch (statusError) {
        console.error(
          `[coder] failed to mark session ${session.id} as error:`,
          statusError,
        );
      }
      rejectTranscriptFlushed(terminalError);
      await checkpointCoordinator.retry(runner.turn, true);
      throw terminalError;
    })
    .finally(async () => {
      await closeChatMailbox?.();
      await toolOutputStore.drain();
      await mcpServerManager.closeAll();
      await bridge.close();
      for (const b of extraBridges) await b.close();
      // Phase 2: `store`, `db` and `skillStore` all share ONE process-wide
      // central connection now (getSharedCentral). They are NOT closed per-run —
      // a concurrent subordinate run shares the same handle. closeSharedCentral()
      // (worker stop handler) + the process-exit hook close it once on teardown.
    });

  return { session, runner, transcriptFlushed, done: donePromise, indexStatus };
}

/**
 * Extract file-shaped tokens from arbitrary text (typically the user's
 * message). Used by the skills 'matched' mode to feed `recentFiles` into
 * the matcher when no formal file context is available — relative paths
 * and `*.ext` mentions are good enough for path-glob triggers.
 *
 * Pure heuristic; misses are fine — when the matcher returns empty, we
 * degrade to the lazy section instead of dumping every skill.
 */
// Helpers moved to './index/helpers.ts': extractFilePathsFromText, defaultModelFor

// Re-export key types for consumers
export {
  FsSessionStore,
  FsSessionStore as SessionStore,
} from '@mcp/session-storage/fs-store/index.js';
export type {
  FsCoderSession as CoderSession,
} from '@mcp/session-storage/fs-store/index.js';
export type { CoderExecutionMode } from '@mcp/session-storage/session-state-types.js';
export type { CoderProviderName } from '@mcp/code-agent/providers/adapter.js';
/**
 * Backwards-compatible alias used by HTTP admin routes. Derived dynamically
 * from the unified registry — all kinds that declare `createCoder`.
 */
export { listCoderKinds as SUPPORTED_CODER_PROVIDERS } from '@mcp/services/providers/factory.js';
