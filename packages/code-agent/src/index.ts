import { resolve as resolvePath, join as joinPath } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import { createDurableSemanticMutationSink } from '@mcp/services/semantic-mutation-sink.js';
import { runTerminalQualityAssessment } from '@mcp/code-agent/terminal-quality.js';
import { getDbWriter, isDbWriterEnabled, type DbWriter } from '@mcp/indexer/workers/dbWriter/client.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { coderToolOutputsBaseDir } from '@mcp/shared/utils/data-paths.js';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { ChatProvider, CoderProviderName } from '@mcp/code-agent/providers/adapter.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
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
import { buildConfigLock, diffConfigLock, getConfigLock, setConfigLock } from '@mcp/code-agent/sessions/store/session-config.js';
import { recordSessionEvent } from '@mcp/code-agent/sessions/store/events-recorder.js';
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
import { getGlobalToolSelectionFilter } from '@mcp/code-agent/tool-selection/global-filter.js';
import {
  appendStaticPromptSection,
  buildSystemPrompt,
  normalizeProviderFamily,
  promoteIndexReadySystemPrompt,
} from '@mcp/code-agent/core/system-prompt.js';
import { buildRepoMap, resolveRepoMapBudget } from '@mcp/code-agent/core/repo-map.js';
import { detectVerifyCommands } from '@mcp/code-agent/core/verify-commands.js';
import { workspaceFromProject, type WorkspaceContext } from '@mcp/code-agent/core/workspace.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { applyPatchTool } from '@mcp/code-agent/tools/apply-patch.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { gitToolsForProject } from '@mcp/code-agent/tools/git.js';
import {
  defaultLocalFilesystemPort,
  defaultLocalShellPort,
  SnapshotRecorder,
  SnapshotRecordingFilesystemPort,
} from '@mcp/code-agent/ports/index.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import { SessionFileReviewStore } from '@mcp/store/session-file-review-store.js';
import { SessionSnapshotService } from '@mcp/services/services/session-snapshots.js';
import { filterReviewableDiffs } from '@mcp/services/services/snapshot-review-ignore.js';
import { SandboxFilesystemAdapter } from '@mcp/services/sandbox/adapters/sandbox-filesystem-adapter.js';
import { SandboxShellAdapter } from '@mcp/services/sandbox/adapters/sandbox-shell-adapter.js';
import { planTools } from '@mcp/code-agent/tools/plan.js';
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
import { buildExpandTools } from '@mcp/code-agent/tools/expand.js';
import { buildFindToolsTool } from '@mcp/code-agent/tools/find-tools.js';
import { buildRequestReviewTool } from '@mcp/code-agent/tools/request-review.js';
import { buildSelfReviewTool } from '@mcp/code-agent/tools/self-review.js';
import { runVerifyCompletionSubagent } from '@mcp/code-agent/tools/verify-completion-subagent.js';
import { McpToolBridge } from '@mcp/code-agent/tools/mcp-bridge.js';
import { buildMcpResourceTools } from '@mcp/code-agent/tools/mcp-resources.js';
import { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import {
  createSubagentProviderResolver,
  type SubagentTarget,
} from '@mcp/code-agent/tools/subagent-provider.js';
import {
  SUBAGENT_PROFILE_IDS,
  type MicroAgentProfileId,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
import { buildSpawnAgentTool } from '@mcp/code-agent/tools/spawn-agent.js';
import { loadPrompt, interpolate } from '@mcp/code-agent/prompts/loader.js';
import { parseDsConsumer, parseDsWorkspace } from '@mcp/code-agent/core/builder-config.js';
import { buildDsConsumerBlock } from '@mcp/code-agent/core/ds-consumer-prompt.js';
import { buildDiagramGuidance } from '@mcp/code-agent/prompts/diagram-guidance.js';
import { buildMasterTools } from '@mcp/company/tools/master-tools.js';
import { buildKanbanTools } from '@mcp/company/tools/kanban-tools.js';
import { buildBoardTools } from '@mcp/company/tools/board-tools.js';
import { buildQaTools, roleHasQaPlaywrightSkill } from '@mcp/company/tools/qa/index.js';
import { buildDesignSystemStudioTools, buildDesignSystemConsumerTools } from '@mcp/company/tools/design-system/index.js';
import { buildAppStudioTools } from '@mcp/company/tools/app-studio/index.js';
import { buildSpriteStudioTools } from '@mcp/code-agent/tools/sprite-studio/index.js';
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
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { ToolOutputStore } from '@mcp/code-agent/overlay/tool-output-store.js';
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
import { ragSearchDocsTools } from '@mcp/code-agent/tools/rag-search-docs.js';
import { ragReadDocTools } from '@mcp/code-agent/tools/rag-read-doc.js';
import { ragDocOutlineTools } from '@mcp/code-agent/tools/rag-doc-outline.js';
import { todoTools, generateTodoId } from '@mcp/code-agent/tools/todo.js';
import { type TodoItem, buildTrackState } from '@mcp/code-agent/tools/task-list-shared.js';
import { viewImageTools } from '@mcp/code-agent/tools/view-image.js';
import { previewTools } from '@mcp/code-agent/tools/preview/index.js';
import { browserTools, isResearchToolAllowed } from '@mcp/code-agent/tools/browser/index.js';
import { goalTools } from '@mcp/code-agent/tools/goal.js';
import { buildSessionDriveTools } from '@mcp/code-agent/tools/session-drive-tools.js';
import { buildConversationChapterTools } from '@mcp/code-agent/tools/conversation-chapters.js';
import { buildProjectMemoryTools } from '@mcp/code-agent/tools/project-memory-tools.js';
import { buildAutoCapture } from '@mcp/code-agent/sessions/auto-capture.js';
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
import { SkillStore } from '@mcp/store/skill-store.js';
import type { ResolvedSkill, SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import { resolveActiveWorkspaceSkills } from '@mcp/code-agent/skills/workspace-skills.js';
import { buildInvokeSkillTool, buildSkillDiscoveryTools } from '@mcp/code-agent/skills/skill-tool-builder.js';
import { buildCreateSkillTool } from '@mcp/code-agent/tools/create-skill.js';
import { listInstalledNamespaces } from '@mcp/code-agent/skills/agent-skills-installer.js';
import {
  buildCompactSkillsSection,
  buildLazySkillsSection,
  buildMatchedSkillsPromptSection,
  buildSkillsPromptSection,
} from '@mcp/code-agent/skills/prompt-injector.js';
import { matchSkills, type SkillMatchContext } from '@mcp/code-agent/skills/skill-matcher.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { PipelineProviderResolver } from '@mcp/services/pipelines/index.js';
import type { CoderSession } from '@mcp/code-agent/sessions/types.js';
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
 * `SessionStore` built from `db.raw()` (`ownsHandle=false`, so it is the SAME
 * single connection — mirrors how `server/deps.ts` shares one handle across ~20
 * stores). Keyed by `dbPath` and guarded against a second path, like
 * `getDbWriter`. Process-owned and intentionally NOT closed per-run: a
 * process-`exit` hook plus the explicit `closeSharedCentral()` (called from the
 * company-worker stop handler) close them once on teardown.
 */
let sharedCentral: { dbPath: string; db: CodeIndexDB; store: SessionStore } | null = null;
let sharedCentralExitHookInstalled = false;

function getSharedCentral(dbPath: string): { db: CodeIndexDB; store: SessionStore } {
  if (sharedCentral && sharedCentral.dbPath !== dbPath) {
    throw new Error(
      `runCoder central DB already opened against ${sharedCentral.dbPath}; cannot reuse for ${dbPath}`,
    );
  }
  if (!sharedCentral) {
    const db = new CodeIndexDB(dbPath);
    // Same single connection for sessions — NOT a 2nd writer on the file.
    // Investigation inserts originate here in both the in-process runner and
    // company/coder workers. Publish their pre-write fence directly to the
    // central semantic control plane; the HTTP coordinator polls external jobs
    // when this process has no in-memory wake-up port.
    const semanticStore = new SemanticStore(db.raw());
    const investigationMutationSink = createDurableSemanticMutationSink(
      semanticStore,
      {
        owner: `coder:${process.pid}:${randomUUID()}`,
        enabled: () =>
          semanticStore.getProfile('memory')?.embedding_target.kind !== 'disabled',
      },
    );
    const store = new SessionStore(db.raw(), investigationMutationSink);
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
 * Close the shared central handles. Idempotent. Called on process exit and
 * explicitly from the company-worker stop handler for a graceful flush.
 */
export function closeSharedCentral(): void {
  if (!sharedCentral) return;
  const held = sharedCentral;
  sharedCentral = null;
  try { held.store.close(); } catch { /* no-op: store shares the db handle */ }
  try { held.db.close(); } catch { /* best-effort */ }
}

/**
 * Build a fully-wired runner for a coder session and start it.
 *
 * Both the CLI and the SSE handler use this. Listeners should be attached
 * to `handle.runner` BEFORE awaiting `handle.done`.
 */
export async function runCoder(opts: RunCoderOptions): Promise<RunCoderHandle> {
  const config = loadConfig();
  // Shared per-process central handles — see getSharedCentral. One connection
  // for the whole worker instead of one per master/subordinate run.
  const { db, store } = getSharedCentral(config.dbPath);
  const dbWriter: DbWriter | null = isDbWriterEnabled() ? getDbWriter(config.dbPath) : null;

  // Resolve or create the session. `agent` is persisted on the session row so
  // resume paths (/continue, reattach) honour the user's preset even when the
  // request body doesn't re-send it.
  let session: CoderSession;
  if ('id' in opts.session) {
    const found = store.getSession(opts.session.id);
    if (!found) throw new Error(`Session ${opts.session.id} not found`);
    session = found;
  } else {
    session = store.createSession({
      project_id: opts.session.create.project_id,
      title: opts.session.create.title,
      provider: opts.session.create.provider,
      model: opts.session.create.model ?? defaultModelFor(opts.session.create.provider),
      agent: opts.agentSelectionId ?? opts.agent ?? null,
    });
  }

  // Sticky agent: if the caller didn't specify one, fall back to the value
  // stored on the session. If they did and it differs, persist the new choice.
  const storedAgent: AgentId | null =
    session.agent && isAgentId(session.agent) ? session.agent : null;
  const effectiveAgentId: AgentId | null = opts.agent ?? storedAgent;
  const requestedSelectionId = opts.agentSelectionId ?? opts.agent;
  if (requestedSelectionId && requestedSelectionId !== session.agent) {
    store.setSessionAgent(session.id, requestedSelectionId);
    session = { ...session, agent: requestedSelectionId };
  }

  // Apply agent defaults for any unspecified knob. This way explicit opts win
  // over presets (e.g. `--agent build --plan` keeps plan mode on), but resume
  // requests with no opts still inherit the preset's profile/planMode.
  const agentDef = effectiveAgentId ? AGENTS[effectiveAgentId] : null;
  if (agentDef) {
    if (opts.profile === undefined) opts = { ...opts, profile: agentDef.profile };
    if (opts.planMode === undefined) opts = { ...opts, planMode: agentDef.planMode };
    if (opts.maxTurns === undefined && agentDef.maxTurns) opts = { ...opts, maxTurns: agentDef.maxTurns };
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

  const project = db.getProject(session.project_id);
  if (!project) throw new Error(`Project ${session.project_id} not found`);
  const unionProjectLinks = project.is_synthetic ? db.listUnionProjectIds(project.id) : [];
  const unionWorkspaceProjects = assignWorkspaceSlugs(unionProjectLinks);

  // Memory READ scope. A GLOBAL session's project is a SYNTHETIC union (mig 155)
  // whose own memory is empty/ephemeral; read the memory of every REAL
  // constituent (primary first) so the agent sees both projects' learnings.
  // For an ordinary project this resolves to `[the project]`, so every memory
  // consumer below stays single-iteration and byte-equivalent to before.
  const allReadProjects: ReadProject[] = project.is_synthetic
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
  // Durable WRITES land on the PRIMARY real constituent (the host adapter
  // redirects the synthetic id); gate the compaction harvest on THAT project's
  // toggle so a disabled primary is never written to via a global session. For
  // an ordinary project this is just `project.id`.
  const memoryWriteProjectId = db.resolveMemoryWriteProject(project.id).id;

  // Global (multi-project) session — v2 VIRTUAL UNION model: the session runs
  // over a SYNTHETIC project whose `root_path` is a directory of junctions to
  // every linked project (built by the http-api). So the normal single-project
  // path ALREADY spans every project — the runner needs no per-project bridges
  // and no multi-root resolver. Kept empty so the Phase-2 bridge loop and the
  // Phase-3 `roots`/`selectRoot` stay completely INERT for normal, company AND
  // global sessions alike.
  const linkedSecondaryProjects: { id: number; name: string; rootPath: string }[] = [];

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
    cloudCodeSessionId = store.getOrCreateCloudCodeSessionId(session.id);
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
  const toolOutputStore = new ToolOutputStore(
    resolvePath(project.root_path),
    session.id,
    project.is_synthetic ? { externalBaseDir: coderToolOutputsBaseDir() } : undefined,
  );

  // Tool registry: native tools + bridged MCP tools
  const registry = new ToolRegistry();
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
  const allowAppCompanyTools = isAppStudioCompany
    && (appCompanyCapabilities?.allowAppTools ?? opts.companyContext?.appStudioSessionId != null);
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
  // A synthetic union root is not itself a Git repository. Keep the existing
  // Git tool contracts untouched for ordinary sessions and omit them here;
  // the global-workspace briefing directs scoped run_command(cwd:<slug>).
  registry.registerAll(gitToolsForProject(!!project.is_synthetic));
  // apply_patch is registered for ALL providers. For ChatGPT/Codex with
  // `apply_patch_tool_type === 'freeform'`, the chatgpt provider rewrites
  // the wire shape to `type: 'custom'` (raw patch text, no JSON escaping).
  // For everyone else (Claude, Gemini, etc.) it stays a regular function
  // tool with a single `patch: string` param — the model emits JSON-
  // escaped patch text and the handler parses it. Costs ~600 extra chars
  // in the system prompt vs gating, but pays off on multi-file edits where
  // a single deterministic patch beats N rounds of edit_file/multi_edit.
  registry.register(applyPatchTool);

  // Company subordinates get master-directed communication tools instead of
  // the human-facing ask_user / submit_plan / submit_tasks. The replacement
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
    // Docs tools write into `<workdir>/docs/` inside the container.
    // Registered for all builder sessions; fail gracefully when the
    // container is down so the agent gets a useful error message.
    registerCompanyTools(docsTools);
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
  registry.registerAll(todoTools);
  registry.registerAll(viewImageTools);
  registry.registerAll(previewTools);
  registry.registerAll(browserTools);
  registry.registerAll(goalTools);
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
  // DS Studio — single sessions on a Design System workspace project get
  // the ds_* tools (record/list/audit/publish) bound to the project. The
  // workspace is identified by `projects.builder_json.kind === 'ds'`
  // (written by the studio scaffold). Company sessions keep their own
  // registration below; the feature flag gates the whole surface.
  const dsWorkspace = !opts.companyContext ? parseDsWorkspace(project.builder_json) : null;
  if (dsWorkspace && config.features.designSystemEnabled) {
    registerCompanyTools(buildDesignSystemStudioTools(project.id));
  }
  // DS CONSUMER — a builder project linked to a PUBLISHED design system
  // (`builder_json.designSystem`, written by the link flow) gets read-only
  // query tools (ds_components/ds_component/ds_docs) so the agent uses the
  // library instead of guessing props. Mutually exclusive with the studio
  // workspace above (parseDsConsumer returns null when kind==='ds').
  const dsConsumer = !opts.companyContext && !dsWorkspace ? parseDsConsumer(project.builder_json) : null;
  if (dsConsumer && config.features.designSystemEnabled) {
    registerCompanyTools(buildDesignSystemConsumerTools(dsConsumer));
  }
  // App Studio v6 tools exist only inside its persistent Company team.
  if (
    allowAppCompanyTools
    && opts.companyContext != null
    && opts.companyContext.appStudioSessionId != null
    && config.features.appStudioEnabled
  ) {
    registerCompanyTools(buildAppStudioTools(project.id, {
      audience: opts.companyContext.isMaster ? 'company-master' : 'company-subordinate',
      appSessionId: opts.companyContext.appStudioSessionId,
      role: opts.companyContext.agentRole,
    }));
  }
  // Sprite Studio — single sessions on a project that has a `.sprite-studio/`
  // directory get the sprite_* tools (get_project/list_assets/generate/
  // process/export) bound to the project. Same posture as DS Studio: outside
  // company context, gated by the feature flag + the on-disk marker. The tools
  // reach the real work through `getGlobalSpriteStudioHost()` (main impl +
  // worker bridge shim).
  const spriteStudioWorkspace =
    !opts.companyContext &&
    config.features.spriteStudioEnabled &&
    existsSync(joinPath(project.root_path, '.sprite-studio'));
  if (spriteStudioWorkspace) {
    registry.registerAll(buildSpriteStudioTools(project.id));
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
  const bridge = new McpToolBridge();
  const extraBridges: McpToolBridge[] = [];
  let mcpBridgeOk = false;

  if (opts.companyContext?.isMaster) {
    // Master: register prefixed MCP tools for ALL company projects
    const companyProjects = opts.companyContext.orchestrator.listProjects();
    for (const proj of companyProjects) {
      const projBridge = new McpToolBridge();
      try {
        await projBridge.connect();
        const slug = projectSlug(proj.name);
        const projOverlay = new SessionOverlay(resolvePath(proj.rootPath));
        const mcpTools = await projBridge.listTools({ projectName: proj.name, overlay: projOverlay });
        // Rename: mcp__read_file → mcp__{slug}__read_file
        const prefixed = mcpTools.map((t) => ({
          ...t,
          name: `mcp__${slug}__${t.name.replace(/^mcp__/, '')}`,
        }));
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
      await bridge.connect();
      const mcpTools = await bridge.listTools({ projectName: project.name, overlay });
      registry.registerAll(mcpTools);
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
    const projBridge = new McpToolBridge();
    try {
      await projBridge.connect();
      const slug = projectSlug(proj.name);
      // Reuse the same overlay the write path uses for this root, so a write
      // and a subsequent MCP read in this project see consistent fresh content.
      const projOverlay = secondaryOverlays.get(proj.id) ?? new SessionOverlay(resolvePath(proj.rootPath));
      const mcpTools = await projBridge.listTools({ projectName: proj.name, overlay: projOverlay });
      const prefixed = mcpTools.map((t) => ({
        ...t,
        name: `mcp__${slug}__${t.name.replace(/^mcp__/, '')}`,
      }));
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
  // expandable custom tier (named by server id) so the agent sees the pack
  // in the system prompt and unlocks it on demand via expand_toolset, instead
  // of the admin's `default_tier` deciding visibility per-server.
  let subordinateTierSummary: Map<string, { displayName: string; toolCount: number }> | undefined;
  const isSubordinate = !!opts.companyContext && !opts.companyContext.isMaster;
  try {
    const mcpServerStore = new McpServerStore(config.dbPath);
    const enabledServers = mcpServerStore.listServers({ enabled: true });
    if (enabledServers.length > 0) {
      await mcpServerManager.connectAll(enabledServers);
      const { tools: extTools, tierMap } = await mcpServerManager.listAllTools();
      if (extTools.length > 0) {
        registry.registerAll(extTools);
        for (const [name, tier] of tierMap) runtimeToolTiers.set(name, tier);
        // Cache discovered tools in DB so admin/session panels see them instantly
        for (const srv of enabledServers) {
          const prefix = `ext_${srv.id}__`;
          const srvTools = extTools
            .filter((t) => t.name.startsWith(prefix))
            .map((t) => ({ name: t.name.slice(prefix.length), description: t.description }));
          if (srvTools.length > 0) mcpServerStore.replaceServerTools(srv.id, srvTools);
        }
        console.log(
          `[coder] ${extTools.length} external tool(s) from ${mcpServerManager.connectedCount} MCP server(s)`,
        );

        if (isSubordinate) {
          const subTierMap = new Map<string, import('@mcp/code-agent/tools/tiers.js').ToolTier>();
          subordinateTierSummary = new Map();
          for (const srv of enabledServers) {
            const prefix = `ext_${srv.id}__`;
            const srvToolNames = extTools.filter((t) => t.name.startsWith(prefix)).map((t) => t.name);
            if (srvToolNames.length === 0) continue;
            for (const n of srvToolNames) subTierMap.set(n, srv.id);
            subordinateTierSummary.set(srv.id, { displayName: srv.name, toolCount: srvToolNames.length });
          }
          for (const [name, tier] of subTierMap) runtimeToolTiers.set(name, tier);
          if (subordinateTierSummary.size > 0) {
            console.log(
              `[coder] subordinate ${opts.companyContext!.agentRole}: external MCPs as opt-in tiers ` +
                `[${[...subordinateTierSummary.keys()].join(', ')}] — call expand_toolset to unlock`,
            );
          }
        }
      }
    }
    mcpServerStore.close();
  } catch (e) {
    console.warn(`[coder] External MCP servers failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Plugin tools — contributed by installed plugins, with worker-backed
  // handlers synthesized by the http-api layer (@mcp/plugin-host
  // buildPluginTools). Each plugin declares its own opt-in runtime tier, so
  // none of these tools leak through getToolTier's bootstrap fallback.
  let pluginTierSummary = new Map<string, { displayName: string; toolCount: number }>();
  if (opts.pluginTools?.length) {
    registry.registerAll(opts.pluginTools);
    const pluginTiers = collectRuntimeToolTiers(opts.pluginTools);
    for (const [name, tier] of pluginTiers.tierMap) runtimeToolTiers.set(name, tier);
    pluginTierSummary = pluginTiers.summary;
  }

  // expand_toolset — registered AFTER external servers and plugins so its tier
  // enum includes every custom runtime group.
  // For subordinates, every enabled MCP server is exposed as its own opt-in tier
  // (regardless of admin's `default_tier`) so the master/session-free behavior
  // (which respects the configured tier) is preserved.
  const customTierSummary = mergeRuntimeTierSummaries(
    subordinateTierSummary ?? mcpServerManager.getCustomTierSummary(),
    pluginTierSummary,
  );
  registry.registerAll(buildExpandTools(customTierSummary.size > 0 ? customTierSummary : undefined));

  // find_tools — Camada 3 lazy discovery. Always registered (cheap, read-only,
  // no tier promotion). Belongs in bootstrap so it's visible before the agent
  // has unlocked anything else. Implementation lives in find-tools.ts.
  registry.registerAll([buildFindToolsTool(registry, runtimeToolTiers)]);

  // request_review — Camada 4 reviewer subagent. Registered with a placeholder
  // tool snapshot; the runner snapshots the registry AFTER all tools are
  // registered so the reviewer's REVIEW_ALLOWLIST resolves correctly. The
  // reviewerProvider falls back to the parent provider when subagentTarget
  // hasn't been configured (legacy single-family behaviour).
  if (!isAppStudioCompany) {
    registry.registerAll([
      buildRequestReviewTool({
        provider,
        parentTools: registry.list(),
        sessionId: session.id,
        sessionStore: store,
        // Reuse the subagent provider plumbing: when an admin has set a
        // different family for subagents (subagentTarget), use it for review.
        reviewerProvider: undefined, // wired at run-time via subagentProvider in subagent.ts
      }),
    ]);
  }

  // Custom agents can opt into an exact tool surface. Apply this after every
  // native/MCP/plugin tool has registered and before subagent snapshots are
  // captured, so the allowlist is an execution boundary rather than a UI-only
  // hint. `undefined` means inherit; `[]` intentionally removes every tool.
  if (opts.allowedToolNames !== undefined) {
    const allowed = new Set(opts.allowedToolNames);
    registry.filterInPlace((tool) => allowed.has(tool.name));
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
    if (disabled.length > 0) globalDisabledTools = new Set(disabled);
  } catch {
    /* table may not exist yet — no-op */
  }
  const sessionDisabledTools = store.getSessionDisabledTools(session.id);

  // Subagent deps — built AFTER MCP tools so it captures the full tool list
  // for filtering. Disabled via CODER_DISABLE_SUBAGENTS=1. Also DISABLED for
  // company Master (it must use spawn_subordinate_agent instead — ephemeral
  // subagents don't fit the orchestration role).
  let subagentDeps: SubagentDeps | null = null;
  if (shouldEnableEphemeralSubagents(opts.companyContext)) {
    const allDisabled = new Set([...(globalDisabledTools ?? []), ...sessionDisabledTools]);
    const parentTools = allDisabled.size > 0
      ? registry.list().filter((t) => !allDisabled.has(t.name))
      : registry.list();
    let subagentProvider: ChatProvider | undefined;
    let resolveProviderForProfile:
      | ((id?: string) => Promise<ChatProvider | undefined>)
      | undefined;
    let resolveEffortForProfile: ((id?: string) => string | undefined) | undefined;
    try {
      const ps = new ProviderStore(config.dbPath);
      const defaultTarget = ps.getSubagentTarget(session.provider);
      const defaultEffort = ps.getSubagentEffort(session.provider);
      // Snapshot per-profile targets + efforts (already default-merged by the
      // store) so the resolver never re-touches the DB after the runner build.
      const profileTargets = new Map<MicroAgentProfileId, SubagentTarget | null>();
      const profileEfforts = new Map<MicroAgentProfileId, string | null>();
      for (const id of SUBAGENT_PROFILE_IDS) {
        profileTargets.set(id, ps.getSubagentProfileTarget(session.provider, id));
        profileEfforts.set(id, ps.getSubagentProfileEffort(session.provider, id));
      }
      ps.close();

      // Default subagent provider (single control) — eager, back-compat.
      const targetProviderId = defaultTarget?.providerId ?? session.provider;
      const targetModel = defaultTarget?.modelId ?? undefined;
      const usesDifferentProvider = targetProviderId !== session.provider;
      const usesDifferentModel = !!targetModel && targetModel !== session.model;
      if (usesDifferentProvider || usesDifferentModel) {
        const sub = await createCoderProvider(targetProviderId, targetModel);
        subagentProvider = sub;
        console.log(`[coder] subagent provider override: ${targetProviderId}:${sub.model}`);
      }

      // Per-profile resolver — lazy + memoized; used by every spawn path.
      const resolver = createSubagentProviderResolver({
        sessionProvider: session.provider,
        sessionModel: session.model,
        defaultTarget: defaultTarget ?? null,
        profileTargets,
        defaultEffort,
        profileEfforts,
        createProvider: createCoderProvider,
      });
      resolveProviderForProfile = (id) => resolver.forProfile(id);
      resolveEffortForProfile = (id) => resolver.effortFor(id);
    } catch { /* non-fatal — falls back to parent provider */ }

    subagentDeps = {
      provider,
      parentTools,
      sessionStore: store,
      subagentProvider,
      resolveProviderForProfile,
      resolveEffortForProfile,
      toolSelectionFilter: opts.toolSelectionFilter ?? getGlobalToolSelectionFilter(),
      externalToolTiers: runtimeToolTiers,
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
      // ds_* tools são exclusivas do DS Studio (sessão single) — o pipeline
      // company de Design System foi aposentado e sessões legacy são
      // read-only, então subordinados não recebem mais esse surface.
    }
    if (isMaster) {
      // review_subordinate_work needs in-process DB access to run the review
      // pipeline over a subordinate's snapshots — supply the shared handle and
      // a project-root resolver (same db/store already in scope here).
      registerCompanyTools(
        buildMasterTools(orchestrator, {
          dbHandle: store.getDb(),
          getProjectRoot: (projectId: number) => db.getProject(projectId)?.root_path ?? null,
        }),
      );
      if (allowCompanyKanban) registerCompanyTools(buildKanbanTools(orchestrator));
      // Strip code-level tools from Master — it should only orchestrate, not read code
      registry.filterInPlace((tool) => isMasterAllowed(tool, {
        allowAppStudio: allowAppCompanyTools,
      }));
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
    const [{ buildResumeAgentTool }, { buildCollectAgentsTool }] = await Promise.all([
      import('@mcp/code-agent/tools/resume-agent.js'),
      import('@mcp/code-agent/tools/collect-agents.js'),
    ]);
    registry.register(buildResumeAgentTool(subagentDeps));
    registry.register(buildCollectAgentsTool(subagentDeps));
  }

  // execute_tasks — wave-based orchestrator (PR 3). Needs subagentDeps to
  // exist; only registers when the session has the subagent capability
  // (i.e. NOT a Company master, NOT CODER_DISABLE_SUBAGENTS=1).
  if (subagentDeps && registry.get('submit_tasks')) {
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
  const snapshotStore = new SessionFileSnapshotStore(store.getDb());
  // Always record under the actual coder_sessions.id of the runner — even
  // inside company orchestration. Company-mode UI aggregates snapshots
  // across master + subordinate coder sessions by joining
  // `company_agent_runs.coder_session_id`, so per-project file paths
  // stay namespaced and unambiguous.
  let runnerRef: import('@mcp/code-agent/core/runner.js').CoderRunner | null = null;
  const recorder = new SnapshotRecorder({
    sessionKind: 'coder',
    sessionId: session.id,
    projectRoot: workspace.rootPath,
    projectId: workspace.projectId,
    // Global session: writes under a linked secondary root are recorded against
    // that root's project (correct diff/revert target). Empty for normal sessions.
    secondaryRoots: secondaryRoots.map((r) => ({ projectId: r.projectId, rootPath: r.rootPath })),
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
      dbHandle: store.getDb(),
      sessionId: session.id,
      projectRoot: workspace.rootPath,
      secondaryRoots: secondaryRoots.map((r) => ({ projectId: r.projectId, rootPath: r.rootPath })),
      // Same-registry access so absence detection resolves references through
      // the project's mcp__find_references (registered above with MCP tools).
      registry,
      projectId: workspace.projectId,
    }),
  );

  // Auto-captured session notes — LLM-free hooks (plan approved, goal
  // completed, task closed, error-streak fixed) that keep the Session State
  // Block useful even when the model never calls save_note on its own.
  const autoCapture = buildAutoCapture({
    store,
    sessionId: session.id,
    enabled: !opts.companyContext && process.env.CODER_AUTO_NOTES !== '0',
    isRepeatable: (name) => {
      try { return registry.get(name)?.repeatable === true; } catch { return false; }
    },
  });

  const toolContext: ToolContext = {
    cwd: effectiveCwd,
    projectName: workspace.displayName,
    globalWorkspace: project.is_synthetic
      ? {
          syntheticProjectName: project.name,
          rootPath: workspace.rootPath,
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
            const sec = secondaryRoots.find((r) => r.projectId === projectId);
            if (sec) return sec.rootPath;
          }
          return workspace.rootPath;
        });
        const diffs = [];
        for (const baselineId of snapshotStore.listActiveBaselineIds('coder', session.id)) {
          const diff = await service.getDiff(baselineId, { context: 3 });
          if (diff) diffs.push(diff);
        }
        return filterReviewableDiffs(diffs);
      },
      getBeforeContent: async (baselineId) => {
        const row = snapshotStore.getBaselineById(baselineId);
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
    recordPlan: (toolUseId, planText) => {
      try {
        store.recordPlan({ session_id: session.id, tool_use_id: toolUseId, plan_text: planText });
      } catch (e) {
        console.warn(`[coder] recordPlan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    resolvePlan: (toolUseId, status, feedback) => {
      try {
        store.resolvePlan(toolUseId, status, feedback);
        if (status === 'approved') {
          const captured = autoCapture.onPlanResolved(
            status,
            store.listPlans(session.id)[0]?.plan_text ?? null,
            feedback,
          );
          if (captured) runnerRef?.requestMilestoneCompaction('milestone:plan-approved');
        }
      } catch (e) {
        console.warn(`[coder] resolvePlan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    setSessionAgent: (agent) => {
      try {
        store.setSessionAgent(session.id, agent);
      } catch (e) {
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
    // Tasks persistence — see migration 008 + SessionStore.recordTasks/etc.
    recordTasks: (toolUseId, state) => {
      try {
        store.recordTasks({ session_id: session.id, tool_use_id: toolUseId, state });
      } catch (e) {
        console.warn(`[coder] recordTasks failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    resolveTasks: (verdict) => {
      try {
        store.resolveTasks(session.id, verdict);
      } catch (e) {
        console.warn(`[coder] resolveTasks failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    updateTaskStatus: (taskId, patch) => {
      try {
        const row = store.updateTaskStatus(session.id, taskId, patch);
        if (autoCapture.onTaskStatus(taskId, patch as Parameters<typeof autoCapture.onTaskStatus>[1])) {
          runnerRef?.requestMilestoneCompaction('milestone:task-closed');
        }
        return row;
      } catch (e) {
        console.warn(`[coder] updateTaskStatus failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    clearTasksState: () => {
      try {
        const cleared = store.clearTasksState(session.id);
        // Also clear the legacy todos_json shadow. Otherwise archive_task_list
        // (which DELETEs the coder_tasks_state row) leaves a stale non-empty
        // todos_json, and the resume migration (which fires when no task-state
        // row exists) would re-fold the intentionally-cleared checklist.
        store.setSessionTodos(session.id, null);
        return cleared;
      } catch (e) {
        console.warn(`[coder] clearTasksState failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    getGoalState: () => {
      try {
        return store.getSessionGoal(session.id);
      } catch (e) {
        console.warn(`[coder] getSessionGoal failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    upsertGoalState: (goal) => {
      try {
        store.upsertSessionGoal(session.id, goal);
        if (autoCapture.onGoalUpserted(goal)) {
          runnerRef?.requestMilestoneCompaction('milestone:goal-completed');
        }
      } catch (e) {
        console.warn(`[coder] upsertSessionGoal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    getTasksState: () => {
      try {
        return store.getTasksState(session.id);
      } catch {
        return null;
      }
    },
    // Session Drive sinks (migrations 125/126) — back the read_plan /
    // remember / list_memory / recall_investigations tools. Reads/writes
    // are best-effort; failures degrade to null/empty rather than aborting
    // the tool call.
    sessionDrive: {
      readActivePlan: () => {
        try {
          const p = store.listPlans(session.id)[0];
          return p ? { text: p.plan_text, status: p.status } : null;
        } catch {
          return null;
        }
      },
      remember: (input) => {
        const row = store.rememberMemory(session.id, input);
        return { title: row.title };
      },
      listMemory: (memOpts) => {
        try {
          return store.listSessionMemory(session.id, memOpts ?? {});
        } catch {
          return [];
        }
      },
      recallInvestigations: async (query, limit) => {
        // Semantic first through the host-owned Knowledge index. Missing
        // generation/provider/worker returns no ids and falls through to the
        // always-available relational lexical recall below.
        try {
          const semantic = getInvestigationSemanticIndex();
          if (semantic) {
            const semanticLimit = limit ?? 8;
            const ids = await semantic.search({ sessionId: session.id, query, limit: semanticLimit });
            const hits = store.recallInvestigationsByIds(session.id, ids, semanticLimit);
            if (hits.length > 0) return hits;
          }
        } catch {
          /* fall through to keyword */
        }
        try {
          return store.recallInvestigations(session.id, query, limit);
        } catch {
          return [];
        }
      },
    },
    conversationHistory: {
      list: (chapterOpts) => store.listConversationChapters(session.id, chapterOpts),
      search: (query, chapterOpts) => store.searchConversationChapters(session.id, query, chapterOpts),
      get: (chapterId) => store.getConversationChapter(session.id, chapterId),
      source: (chapterId, chapterOpts) => store.listConversationChapterSource(session.id, chapterId, chapterOpts),
    },
    // Durable project memory ports (save_note scope 'project' + recall_memory).
    // Gated on the per-project toggle (any union member for a global session);
    // absent ports → tools answer clearly. `save` keeps the session's project id
    // (the synthetic one for a global session) — the host adapter redirects it
    // to the primary real project so durable facts never land on the throwaway
    // union. `recall` reads the whole union (interleaved + labeled by project).
    projectMemory:
      opts.projectMemory && anyMemoryEnabled
        ? {
            save: (entry) => opts.projectMemory!.save(project.id, project.name, entry),
            recall: async (query, limit) => {
              if (memoryReadProjects.length <= 1) {
                return opts.projectMemory!.recall(project.id, project.name, query, limit);
              }
              const perProject = await mapProjectsConcurrent(
                memoryReadProjects,
                (p) =>
                  opts
                    .projectMemory!.recall(p.id, p.name, query, limit)
                    .then((rows) => ({ name: p.name, rows }))
                    .catch(() => ({ name: p.name, rows: [] })),
              );
              return interleaveLabeled(perProject, limit);
            },
            ...(opts.projectMemory.list
              ? { list: (limit, type) => opts.projectMemory!.list!(project.id, project.name, limit, type) }
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
          ...(opts.projectMemory.forget
            ? { forget: (target) => opts.projectMemory!.forget!(0, '__user__', target) }
            : {}),
        }
      : undefined,
    companyContext: opts.companyContext,
    // Coder session id — keys per-agent resources (preview/devtools window).
    sessionId: session.id,
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
  const existingEarly = store.loadSessionWithMessages(session.id);
  const initialMessagesEarly: AgentMessage[] = existingEarly?.messages ?? [];
  // A durable compaction can leave a session with a summary but zero visible
  // rows (full "summarize & clear") — that's still a resumed session, not fresh.
  const hasHistory0 = initialMessagesEarly.length > 0 || !!existingEarly?.session.compaction_summary;

  // On session resume, recover tasks stuck in 'running' — the previous runner
  // died before the task could finish. Mark them as 'interrupted' so the model
  // can retry via execute_task.
  if (hasHistory0) {
    store.recoverStaleTasks(session.id);
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
  const stickyToolset = process.env.CODER_STICKY_PROFILE !== '0';
  const persistedToolset = stickyToolset
    ? parseToolsetState(session.tool_profile, session.tool_state_json)
    : null;
  // Seeded sessions cap the visible tool list at min(model cap, this) —
  // real reduction even on large-catalog models. NEVER_TRIM + pins survive.
  // The cap is persisted (widen-only state) so resumes rebuild the SAME
  // visible membership instead of dropping the cut and re-flipping the array.
  const preflightCapRaw = Number.parseInt(process.env.CODER_PREFLIGHT_VISIBLE_CAP ?? '', 10);
  const seededToolCap = preflightSeed
    ? (Number.isFinite(preflightCapRaw) && preflightCapRaw > 0 ? preflightCapRaw : 48)
    : undefined;
  const sessionToolCap = seededToolCap ?? persistedToolset?.visibleCap ?? undefined;
  if (stickyToolset && seededToolCap != null) {
    try { store.mergeSessionToolsetState(session.id, { visibleCap: seededToolCap }); } catch { /* best-effort */ }
  }
  const profileResolution = resolveSessionProfile({
    explicitProfile:
      opts.profile ??
      (process.env.CODER_PROFILE as CoderProfile | 'auto' | undefined) ??
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
    const skillProjectIds = project.is_synthetic && unionProjectLinks.length > 0
      ? unionProjectLinks.map((linked) => linked.project_id)
      : [session.project_id];
    resolvedSkills = resolveActiveWorkspaceSkills(skillStore, session.id, skillProjectIds);
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
        buildInvokeSkillTool(toolModeSkills, skillTemplateCtx, config.dbPath, session.id, store),
      );
    }
  }

  // create_skill — registered unconditionally (navigate tier) so the agent can
  // author the FIRST skill in an empty catalog. Captures dbPath + registry for
  // tool-name validation and the trigger eval.
  registry.register(
    buildCreateSkillTool({ dbPath: config.dbPath, registry, projectId: session.project_id }),
  );

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
  const verifyCommands = detectVerifyCommands(project.root_path);

  // Agent Loop v2 — ON by default for new sessions. Set CODER_AGENT_LOOP_V2=0
  // to opt out (e.g. for cache-stability comparisons or to roll back without
  // a deploy). Resolved here so the static "Agent loop" + "Active context"
  // pointer in the system prompt and the runner's <active-context> injection
  // stay in sync.
  const agentLoopV2EnvFlag = process.env.CODER_AGENT_LOOP_V2 !== '0';

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
    const rawDb = store.getDb();
    const currentLock = buildConfigLock({
      provider: session.provider,
      model: session.model,
      permissionMode: resolvedPermissionMode,
      reasoningEffort: session.reasoning_effort_override,
      planDepth: session.plan_depth_override,
      responseLanguage: session.response_language_override,
      outputStyle: session.output_style_override,
      temperature: session.temperature_override,
      toolOutputCapLevel: session.tool_output_cap_level,
      nowMs: Date.now(),
    });
    const storedLock = getConfigLock(rawDb, session.id);
    if (!storedLock) {
      setConfigLock(rawDb, session.id, currentLock);
      recordSessionEvent(rawDb, {
        session_id: session.id,
        kind: 'config_captured',
        to_state: `${session.provider}/${session.model}`,
        actor: 'system',
      });
    } else {
      const drift = diffConfigLock(storedLock, currentLock);
      if (drift.length > 0) {
        console.warn(`[coder] session ${session.id} config drift on resume: ${drift.join('; ')}`);
        recordSessionEvent(rawDb, {
          session_id: session.id,
          kind: 'config_drift',
          reason: drift.join('; '),
          actor: 'resume',
        });
      }
    }
  } catch (e) {
    console.warn(`[coder] config-lock check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const availableTools = new Set(registry.list().map((tool) => tool.name));
  const effectiveMcpAvailable = [...availableTools].some((name) => name.startsWith('mcp__'));
  let systemPrompt = buildSystemPrompt({
    projectName: project.name,
    projectRoot: project.root_path,
    globalWorkspace: toolContext.globalWorkspace,
    os: process.platform,
    planMode: opts.planMode,
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
    // Tool-visibility hint for small-catalog models (GLM flash class).
    // Registry is fully populated by now (native + company + MCP); the
    // count is a session-start approximation, which is all the hint needs.
    toolCap: {
      maxTools: sessionToolCap != null
        ? Math.min(getModelMaxTools(session.model), sessionToolCap)
        : getModelMaxTools(session.model),
      approxCatalog: registry.list().length,
    },
    // Effective permission/sandbox policy surfaced to the model: the real
    // writable root (sandbox workdir or project root) + the approval mode.
    // Cache-stable axis above SYSTEM_PROMPT_DYNAMIC_BOUNDARY.
    permissions: {
      writableRoots: [effectiveCwd],
      approvalMode: resolvedPermissionMode,
    },
    // AGENTS.md project instructions (loaded above). '' when none → block omitted.
    agentsMd,
    availableTools,
  });

  if (opts.customAgentPrompt?.trim()) {
    systemPrompt = appendStaticPromptSection(
      systemPrompt,
      `# Custom agent instructions\n${opts.customAgentPrompt.trim()}`,
    );
  }

  // Append company prompt block (master orchestration or subordinate instructions)
  if (opts.companyPromptBlock) {
    systemPrompt = appendStaticPromptSection(systemPrompt, opts.companyPromptBlock);
  }

  // DS Studio block — appended (not replacing the agent prompt) so the
  // `builder` agent identity stays intact and the prefix remains
  // cache-stable: every value comes from builder_json, fixed at scaffold
  // time, no DB query per turn.
  if (dsWorkspace) {
    systemPrompt = appendStaticPromptSection(systemPrompt, interpolate(loadPrompt('ds-studio'), {
      packageName: dsWorkspace.packageName ?? '(see ds_get_session_info)',
      stack: dsWorkspace.stack,
      publishExtra: dsWorkspace.stack === 'angular'
        ? '4. Angular only: run `ng build pkg` first and publish the BUILT output (`ds_publish_version({ pkg_dir: "dist/pkg" })`).'
        : '',
    }));
    // Mode block (fidelity/creative) — same cache-stability contract:
    // `mode` is immutable in builder_json. Pre-mode workspaces get none.
    if (dsWorkspace.mode) {
      systemPrompt = appendStaticPromptSection(systemPrompt, interpolate(loadPrompt(`ds-studio-${dsWorkspace.mode}`), {
        stack: dsWorkspace.stack,
      }));
    }
  } else if (dsConsumer && config.features.designSystemEnabled) {
    // DS consumer block — derives from the pinned published version
    // (immutable rows), so the prefix stays byte-stable across turns.
    systemPrompt = appendStaticPromptSection(systemPrompt, buildDsConsumerBlock(dsConsumer));
  }

  // Draw.io diagram guidance — appended only when the `diagram` tier will be
  // active (the `diagram` agent, or a session that persisted
  // expand_toolset('diagram')). Static + byte-stable → prompt-cache safe.
  const diagramTierActive =
    effectiveAgentId === 'diagram' ||
    (persistedToolset?.extraTiers?.includes('diagram') ?? false);
  if (diagramTierActive) {
    systemPrompt = appendStaticPromptSection(systemPrompt, buildDiagramGuidance());
  }

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
  let skillsModeUsed: 'lazy' | 'compact' | 'matched' | 'full' | 'none' = 'none';
  if (resolvedSkills.length > 0) {
    const envMode = (process.env.CODER_SKILLS_PROMPT_MODE ?? '').toLowerCase().trim();
    const inCompany = !!opts.companyContext;
    const mode: 'lazy' | 'compact' | 'matched' | 'full' =
      envMode === 'lazy' || envMode === 'compact' || envMode === 'matched' || envMode === 'full'
        ? envMode
        : inCompany
          ? 'matched'
          : 'lazy';

    if (mode === 'lazy') {
      systemPrompt += buildLazySkillsSection(resolvedSkills);
      skillsModeUsed = 'lazy';
    } else if (mode === 'compact') {
      systemPrompt += buildCompactSkillsSection(resolvedSkills);
      skillsModeUsed = 'compact';
    } else if (mode === 'matched') {
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
        systemPrompt += buildMatchedSkillsPromptSection(matched, skillTemplateCtx);
        skillsModeUsed = 'matched';
      } else {
        // No matches: degrade to lazy rather than dumping the full list.
        systemPrompt += buildLazySkillsSection(resolvedSkills);
        skillsModeUsed = 'lazy';
      }
    } else {
      systemPrompt += buildSkillsPromptSection(resolvedSkills, skillTemplateCtx);
      skillsModeUsed = 'full';
    }
  }

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
    app: allowAppCompanyTools,
    designSystemStudio: dsWorkspace != null && config.features.designSystemEnabled,
    designSystemConsumer: dsConsumer != null && config.features.designSystemEnabled,
    spriteStudio: spriteStudioWorkspace,
    isMaster: opts.companyContext?.isMaster === true,
    previewAvailable: opts.previewAvailable,
    browserAvailable: opts.browserAvailable,
    agentId: effectiveAgentId,
    companyRole: opts.companyContext?.agentRole,
  })) {
    activeTiers.add(tier);
  }
  // Sticky extra tiers (mig 142): master/preview/custom tiers this session
  // unlocked in PRIOR runs via `expand_toolset`. A persisted tier name that
  // no longer exists simply never matches in `filterByTiers` — harmless.
  if (persistedToolset) {
    for (const t of persistedToolset.extraTiers) activeTiers.add(t as ToolTier);
  }
  if (process.env.CODER_LOG_TOOLS_COUNT === '1') {
    console.log(
      `[coder] agent=${effectiveAgentId ?? 'none'} profile=${preResolvedProfile} planMode=${opts.planMode ?? false} active_tiers=${Array.from(activeTiers).sort().join(',')}`,
    );
  }

  // Pin re-derivation (resume): tools the conversation ALREADY used whose
  // tier is not active now — master/preview/custom-tier calls that
  // inferProfileFromHistory cannot cover (it only widens across the 3 core
  // profiles). Without this a resumed session would hide tools it
  // demonstrably used. Unioned with the pins persisted on the session row
  // (mig 142) so a pin earned in a prior run survives even after the message
  // that used it was compacted out of the loaded tail — pinned membership
  // must stay byte-stable across runs for the provider prompt-cache prefix.
  const configuredInitialPins = new Set(opts.initialPinnedTools ?? []);
  const initialPinnedTools = [
    ...new Set([
      ...(persistedToolset?.pins ?? []),
      ...historyToolNames.filter((n) => !activeTiers.has(getToolTier(n, runtimeToolTiers))),
      // Preflight pins — already validated against the catalog by the host
      // service; pins traverse the tier filter and survive the tool cap.
      ...(preflightSeed?.pinTools ?? []),
      // Durable role presets (Company/App Studio). Like preflight pins these
      // seed visibility, not authority: registry/disabled/policy boundaries
      // still apply and find_tools/expand_toolset can grow the surface.
      ...(opts.initialPinnedTools ?? []),
      ...(effectiveAgentId === 'research' ? ['web_search', 'web_fetch'] : []),
      // P4 — native read_file is navigate-tier (mcp__read_file owns the
      // bootstrap read surface). Without the bridge there is NO read tool on
      // turn 1, so seed the disk fallback as a pin. Constant-per-session
      // (bridge availability is known at setup) → cache-prefix safe.
      ...(!mcpBridgeOk ? ['read_file'] : []),
    ]),
  ];
  if (stickyToolset && initialPinnedTools.length > 0) {
    const known = new Set(persistedToolset?.pins ?? []);
    // Role-configured pins are supplied again on every run. Keeping them out
    // of sticky state means removing one in the role editor takes effect on
    // the next cycle instead of widening that session forever.
    const freshPins = initialPinnedTools.filter((p) => (
      !known.has(p) && !configuredInitialPins.has(p)
    ));
    if (freshPins.length > 0) {
      try { store.mergeSessionToolsetState(session.id, { addPins: freshPins }); } catch { /* best-effort */ }
    }
  }
  if (initialPinnedTools.length > 0 && process.env.CODER_LOG_TOOLS_COUNT === '1') {
    console.log(`[coder] initial pins (persisted+history+preflight+role): ${initialPinnedTools.slice().sort().join(',')}`);
  }

  // ─── Runtime hooks ─────────────────────────────────────────────
  const hookRegistry = new RuntimeHookRegistry();
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
    const FILE_WRITE_TOOLS = new Set(['write_file', 'create_file', 'edit_file', 'multi_edit', 'manage_path']);
    const pending = new Set<string>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    hookRegistry.onToolCall('after', (ctx) => {
      if (!FILE_WRITE_TOOLS.has(ctx.toolName)) return;
      if (ctx.result?.isError) return;
      const rawPaths = [ctx.toolArgs.path ?? ctx.toolArgs.file_path];
      if (ctx.toolName === 'manage_path') rawPaths.push(ctx.toolArgs.from_path, ctx.toolArgs.to_path);
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
    const FILE_MUTATING_TOOLS = new Set(['write_file', 'create_file', 'edit_file', 'multi_edit', 'manage_path']);
    hookRegistry.onToolCall('after', (ctx) => {
      if (!FILE_MUTATING_TOOLS.has(ctx.toolName)) return;
      if (ctx.result?.isError) return;
      const rawPaths = [ctx.toolArgs.path ?? ctx.toolArgs.file_path];
      if (ctx.toolName === 'manage_path') rawPaths.push(ctx.toolArgs.from_path, ctx.toolArgs.to_path);
      const rawStrs = rawPaths
        .filter((raw): raw is string | number | boolean => raw != null)
        .map((raw) => (typeof raw === 'string' ? raw : String(raw)))
        .filter(Boolean);
      if (rawStrs.length === 0) return;
      // Global session: an edit may target a linked secondary root (the tool's
      // `project` slug). Resolve the target root + project id ONCE per call so
      // the refresh re-indexes the RIGHT project, not always the primary.
      // `secondaryRoots` is empty for normal sessions → always the primary.
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
      const idxRoot = target?.rootPath ?? toolContext.cwd;
      const idxProjectId = target?.projectId ?? project.id;
      // Normalize to the same shape the scanner stores in `files.path`:
      // forward slashes, no leading `./`, no trailing slash. Without this,
      // `db.getFile(projectId, relPath)` misses on Windows (backslashes) or
      // when the agent passes `./src/foo.ts`, and the tree-sitter refresh
      // is silently skipped.
      for (const rawStr of rawStrs) {
        const relPath = rawStr.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        // Async, non-blocking. `loadIncrementalIndexer` (module-level lazy
        // singleton above) defers the tree-sitter WASM load to the first
        // mutation in this process — sessions that never edit code pay
        // zero cost. Subsequent calls reuse the cached `indexFileNow`
        // reference without re-entering the module resolver.
        void (async () => {
          try {
            const indexFileNow = await loadIncrementalIndexer();
            const abs = resolvePath(idxRoot, relPath);
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
  // Always defined so the runner can refresh OAuth credentials (e.g. the
  // Copilot 25-min token) on 401 even when no fallback chain is configured.
  const createProviderForFallback = async (name: string, model: string) => {
    return createCoderProvider(name, model);
  };
  let fallbackChain: import('@mcp/code-agent/core/fallback.js').FallbackChain | undefined;
  // App role fallbacks are owned by the Company lifecycle, which records the
  // effective model and fallback reason on company_agent_runs before retrying.
  // Letting the coder-local provider/env chain run here could silently jump to
  // a global mini model without updating that provenance. Generic Company and
  // solo sessions retain their existing fallback chain unchanged.
  if (!isAppStudioCompany) {
    try {
      const { buildFallbackChain } = await import('@mcp/code-agent/core/fallback.js');
      const providerStore = new ProviderStore(config.dbPath);
      const sessionFallback = store.getSessionFallback(session.id);
      const providerChain = providerStore.getFallbackChain(session.provider);
      providerStore.close();
      const chain = buildFallbackChain(
        sessionFallback,
        providerChain,
        process.env.CODER_FALLBACK_CHAIN,
      );
      if (chain.entries.length > 0) {
        fallbackChain = chain;
        console.log(`[coder] Fallback chain: ${chain.entries.map((e) => `${e.provider}:${e.model}`).join(' → ')}`);
      }
    } catch {
      // Fallback config not available (migration not run yet) — skip silently
    }
  }

  // ─── A1: independent goal-completion verifier (CODER_GOAL_VERIFY) ─────
  // At a text-only finish the runner asks this to confirm the ORIGINAL goal is
  // actually met before ending — the "stop-condition verifier" half of Claude
  // Code's two-agent split. It spawns a READ-ONLY verifier subagent on a CLEAN
  // context (never sees this run's transcript); the verifier runs `git_diff`
  // itself (REVIEW_ALLOWLIST) and reads files to confirm. Cross-model when a
  // `goal_verification` pipeline binding is set, else it reuses the parent
  // provider (still clean-context independent). Fail-open + bounded by the BT
  // (ctx.goalVerifyAttempts) — it can never block or loop the run. Off by
  // default and skipped for company subordinates (the master gates those).
  const verifyGoalCompletion =
    process.env.CODER_GOAL_VERIFY === '1' && !opts.companyContext
      ? async (): Promise<{ goalMet: boolean; gaps: ReadonlyArray<{ description: string; severity: string }> } | null> => {
          try {
            const state = store.getSessionStateData(session.id);
            const goalText = state?.goal?.text?.trim();
            if (!state || !goalText || state.filesChanged.length === 0) return null;
            let verifier: ChatProvider | null = null;
            try {
              const resolver = new PipelineProviderResolver(
                new PipelineProviderBindingsStore(store.getDb()),
                new ProviderStore(store.getDb()),
              );
              const bound = await resolver.resolveOrNull('goal_verification', 'reviewer', {
                sessionId: session.id,
              });
              if (bound) verifier = await createCoderProvider(bound.provider.id, bound.modelId);
            } catch {
              /* fall back to the parent provider */
            }
            const result = await runVerifyCompletionSubagent(
              {
                provider: verifier ?? provider,
                tools: registry.list(),
                ctx: toolContext,
                sessionId: session.id,
                sessionStore: store,
                agentLoopV2: agentLoopV2EnvFlag,
              },
              { goal: goalText, plan: state.activePlan?.text ?? null, diff: '', testSummary: null },
            );
            return { goalMet: result.goalMet, gaps: result.gaps };
          } catch {
            return null; // fail-open — the verifier must never block the run
          }
        }
      : undefined;

  // ─── Context window (DB-first, registry fallback) ────────────────
  // The DB is the source of truth WHEN populated, but ZAI / new model
  // releases / hand-imported configs frequently leave it null. Fall back
  // to the static registry (which now has prefix-matching, see
  // capabilities.ts) so the dashboard's context bar renders for legacy
  // sessions without forcing a re-discovery.
  let sessionContextWindow: number | null = null;
  try {
    const ps = new ProviderStore(config.dbPath);
    const dbModel = ps.listModels(session.provider).find((m) => m.model_id === session.model);
    ps.close();
    sessionContextWindow = dbModel?.context_window ?? null;
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
  // (provider, model) for their entire lifetime. The DB column
  // `coder_sessions.phase_profile_id` is left untouched for any future
  // re-enable; the runner ignores it.

  // Agent Loop v2 — ON by default for new sessions. When enabled, the runner
  // injects a live <active-context> block per turn, adds a static "Agent
  // loop" framing to the system prompt, applies a stop-guard for unfinished
  // todos, includes a recap on auto-continue, and refuses tool calls that
  // produce identical content to a recent result. Set CODER_AGENT_LOOP_V2=0
  // to disable.
  const agentLoopV2 = agentLoopV2EnvFlag;

  // Fix A — self_review nudge signals. Reuses `snapshotStore` (active
  // baselines) + a review store (auto-review runs) so the Executing node only
  // nudges when there are UNREVIEWED changes — instead of every turn that has
  // any pending snapshot (forever, since `self_review` never closes them).
  const reviewStore = new SessionFileReviewStore(store.getDb());
  // SQLite `datetime('now')` is UTC `YYYY-MM-DD HH:MM:SS` → ms-epoch.
  const sqliteToMs = (s: string | null): number | null => {
    if (!s) return null;
    const ms = Date.parse(`${s.replace(' ', 'T')}Z`);
    return Number.isNaN(ms) ? null : ms;
  };

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
      new PipelineProviderBindingsStore(store.getDb()),
      new ProviderStore(store.getDb()),
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

  const runner = new CoderRunner({
    provider,
    compactionProvider,
    contextWindow: sessionContextWindow,
    compactionSummaryOptions,
    registry,
    systemPrompt,
    toolContext,
    initialMessages,
    sessionId: session.id,
    sessionStore: store,
    skillStore,
    // self_review reminder signal — true when this session has active
    // (un-kept/un-reverted) snapshots worth validating. Drives the
    // CODER_SELF_REVIEW system-reminder nudge in the Executing node.
    hasReviewableChanges: () => {
      try {
        return snapshotStore.listActiveBaselineIds('coder', session.id).length > 0;
      } catch {
        return false;
      }
    },
    // Fix A — richer self_review signals (pending-change fingerprint + last
    // auto-review marker) so the nudge fires only for UNREVIEWED changes and
    // hard-stops after a cap. Best-effort: any read error → null (node falls
    // back to `hasReviewableChanges`).
    collectSelfReviewSignals: () => {
      try {
        const actives = snapshotStore.listBaselines('coder', session.id);
        const editMs = actives
          .map((b) => sqliteToMs(b.last_edited_at))
          .filter((n): n is number => n != null);
        const lastEditAt = editMs.length ? Math.max(...editMs) : null;
        const pendingFingerprint = actives.length ? `${actives.length}:${lastEditAt ?? 0}` : '';
        const autoCompleted = reviewStore
          .listRuns('coder', session.id)
          .filter((r) => r.source === 'auto' && r.status === 'completed');
        const reviewMs = autoCompleted
          .map((r) => sqliteToMs(r.completed_at))
          .filter((n): n is number => n != null);
        const lastReviewAt = reviewMs.length ? Math.max(...reviewMs) : null;
        return { pendingFingerprint, lastEditAt, lastReviewAt, totalAutoReviews: autoCompleted.length };
      } catch {
        return null;
      }
    },
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
    // Mem C — LLM memory-query synthesizer for meta/continuation messages.
    // Wired only when the host provided one AND memory is enabled; the
    // Executing node calls it fail-open and falls back to its walk-back
    // heuristic when it returns null (or isn't wired at all).
    synthesizeMemoryQuery:
      opts.memoryQuerySynthesizer && anyMemoryEnabled
        ? (tail) => opts.memoryQuerySynthesizer!(tail)
        : undefined,
    // Session State Block data — non-company sessions only. The runner
    // renders goal/plan/todos/notes/files/recall into a `<session-state>`
    // tail block per the window-scaled policy, so continuity never depends
    // on summarization alone. Best-effort: any read error → no block.
    getSessionStateData: opts.companyContext
      ? undefined
      : () => {
          try {
            return store.getSessionStateData(session.id);
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
    getConversationChapterIndex:
      process.env.CODER_CONVERSATION_CHAPTERS !== '0'
        ? () => {
            try {
              const page = store.listConversationChapters(session.id, { limit: 10 });
              return {
                total: store.countConversationChapters(session.id),
                entries: page.items.map((chapter) => ({
                  id: chapter.id,
                  ordinal: chapter.ordinal,
                  title: chapter.title,
                  source: chapter.source,
                })),
              };
            } catch {
              return null;
            }
          }
        : undefined,
    getRelevantConversationChapters:
      process.env.CODER_CONVERSATION_CHAPTERS !== '0'
        ? async (taskText) => {
            try {
              return store
                .searchConversationChapters(session.id, taskText, { limit: 2 })
                .items.slice(0, 2)
                .map((chapter) => ({
                  id: `conversation-chapter:${chapter.id}`,
                  title: chapter.title,
                  content: chapter.chapter_text.slice(0, 400),
                }));
            } catch {
              return [];
            }
          }
        : undefined,
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
    maxTurns: opts.maxTurns ?? 50,
    planMode: opts.planMode,
    // Mirror the same resolution used for the system-prompt's plan-depth block
    // so the runner's decision-gate nudge can skip `simple` tasks.
    planDepth:
      opts.planDepth
      ?? (session.plan_depth_override as 'simple' | 'normal' | 'complex' | null)
      ?? 'normal',
    specMode: opts.specMode ?? (effectiveAgentId === 'spec'),
    thinking: opts.thinking,
    thinkingBudgetTokens: opts.thinkingBudgetTokens,
    modelSupportsVision: opts.modelSupportsVision,
    describeImages: opts.describeImages,
    activeTiers,
    initialPinnedTools: initialPinnedTools.length > 0 ? initialPinnedTools : undefined,
    // Sticky toolset (mig 142): persist mid-run tier promotions so the next
    // resume rebuilds the SAME tool array (prompt-cache prefix stability).
    // navigate/admin widen the core profile; master/preview/custom land in
    // extraTiers. Persistence must never break the run.
    onTierPromoted: stickyToolset
      ? (tier) => {
          try {
            if (tier === 'navigate') store.setSessionToolProfile(session.id, 'navigate');
            else if (tier === 'admin') store.setSessionToolProfile(session.id, 'full');
            else store.mergeSessionToolsetState(session.id, { addExtraTiers: [tier] });
          } catch { /* best-effort */ }
        }
      : undefined,
    preflightHint: preflightHintSeed ? renderPreflightHint(preflightHintSeed) : undefined,
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
    verifyGoalCompletion,
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
    // Reasoning-effort override (orthogonal to thinking). Company callers pass
    // the master/role config value via opts; single sessions fall back to the
    // sticky `coder_sessions.reasoning_effort_override` column (migration 149).
    reasoningEffort: opts.reasoningEffort ?? session.reasoning_effort_override ?? undefined,
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
    // A1 — per-session tunables (push caps, turn budget). Undefined →
    // runner uses envTunables() = bit-identical to pre-A1 constants.
    tunables: opts.tunables,
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
    // ToolSelectionPipeline filter — per-call override wins, otherwise
    // we fall back to the module-level global installed by the boot
    // path (see `setGlobalToolSelectionFilter`). When neither is set,
    // the field is undefined and the runner skips the hook entirely.
    toolSelectionFilter: opts.toolSelectionFilter ?? getGlobalToolSelectionFilter(),
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
        systemPrompt = promoteIndexReadySystemPrompt(systemPrompt, {
          mcpAvailable: effectiveMcpAvailable,
          sessionDrive: availableTools.has('save_note') || availableTools.has('read_plan'),
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

  // Post-merge migration: the lightweight checklist now lives in the unified
  // task store (coder_tasks_state, gate:'track') — one row per session. On
  // resume, if a session has a legacy `todos_json` but no task state yet, fold
  // it into a track-gate state so the sidebar comes back. If a task state
  // already exists it is the source of truth — leave it alone.
  if (session.todos_json && !store.getTasksState(session.id)) {
    try {
      const parsed = JSON.parse(session.todos_json) as Array<Partial<TodoItem>>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const hydrated: TodoItem[] = parsed.map((t) => ({
          id: typeof t.id === 'string' && t.id.length >= 6 ? t.id : generateTodoId(),
          content: typeof t.content === 'string' ? t.content : '',
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : '',
          status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
        }));
        store.recordTasks({
          session_id: session.id,
          tool_use_id: `track_migrate_${session.id}`,
          state: buildTrackState(hydrated),
        });
      }
    } catch (e) {
      console.warn(`[coder] failed to migrate todos_json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Persist todos on every `todos_updated` event and re-emit nothing else.
  runner.on('todos_updated', ({ todos }) => {
    try {
      store.setSessionTodos(session.id, JSON.stringify(todos));
    } catch (e) {
      console.warn(`[coder] setSessionTodos failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Session-start worktree: when the caller passes `opts.worktree` AND the
  // session does not already have one persisted, create the worktree now
  // and scope the runner into it before the first turn. This is the primary
  // path — users decide "run in an isolated worktree" once, at creation,
  // instead of having the agent figure it out mid-run via the admin tool.
  if (opts.worktree && !session.worktree_path) {
    const created = createProjectWorktree(resolvePath(project.root_path), opts.worktree);
    if (created.ok) {
      runner.enterWorktreeScope(created.path);
      try {
        store.setSessionWorktree(session.id, created.path);
      } catch (e) {
        console.warn(`[coder] failed to persist session worktree: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log(`[coder] session ${session.id} started in worktree ${created.path} (branch ${created.branch})`);
    } else {
      console.warn(`[coder] session-start worktree creation failed: ${created.error} — running in the project root instead`);
    }
  }

  // Rehydrate the worktree scope on session resume. If the DB says this
  // session was inside a worktree when the server stopped, put the runner
  // back there before the first turn runs so tool calls see the right cwd.
  if (session.worktree_path && existsSync(session.worktree_path)) {
    // Only enter if the session-start path above didn't already do it.
    if (!runner.worktreePath) runner.enterWorktreeScope(session.worktree_path);
  } else if (session.worktree_path) {
    // Worktree directory was deleted externally — clear the column so the
    // next resume doesn't trip on the stale path.
    console.warn(`[coder] session ${session.id} worktree_path ${session.worktree_path} no longer exists — clearing`);
    try {
      store.setSessionWorktree(session.id, null);
    } catch {
      /* ignore */
    }
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
    const roundMessageId = store.appendMessage(session.id, {
      role: 'user',
      content: userBlocks,
      ...(pickExtras ?? {}),
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
    runner.setRoundMessageId(latestPersistedUser?.id ?? null);
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
  // flush to the DB in a single transaction at turn boundary. Prevents orphaned
  // tool rows if the process crashes mid-turn.
  const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

  interface PendingTurn {
    message: AgentMessage;
    usage: ChatUsage | null;
    toolCalls: Array<{
      tool_use_id: string;
      tool_name: string;
      args: Record<string, unknown>;
      result_text: string;
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
      turn_telemetry_id: number | null;
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
  let flushChain: Promise<void> = Promise.resolve();

  const flushPendingTurn = (): Promise<void> => {
    // Detach the buffer synchronously. EventEmitter callers intentionally do
    // not await this function; capturing here prevents the next message_complete
    // from replacing the turn before its queued DB write starts.
    if (!pendingTurn) return flushChain;
    const turn = pendingTurn;
    pendingTurn = null;
    const telemetryId = runner.lastTurnTelemetryId;
    const persist = async (): Promise<void> => {
    // If this turn was checkpointed while awaiting input (see `awaiting_input`),
    // wait for that write to settle and reuse its row id so we COMPLETE (not
    // duplicate) the assistant message. State lives on `turn`, so a later turn's
    // checkpoint cannot clobber ours across this await.
    if (turn.checkpoint) {
      try { await turn.checkpoint.promise; } catch { /* fall back to fresh insert */ }
    }
    // By now persistTurnTelemetry has run for this turn (runner emits
    // it before turn_start), so lastTurnTelemetryId points at the row we
    // want to JOIN against. Stamp every tool call with it.
    if (telemetryId != null) {
      for (const tc of turn.toolCalls) tc.turn_telemetry_id = telemetryId;
      for (const tc of turn.nestedToolCalls) tc.turn_telemetry_id = telemetryId;
    }
    const hasSubUsage = turn.subagentUsage.input_tokens > 0
      || turn.subagentUsage.output_tokens > 0;
    const payload = {
      session_id: session.id,
      message: turn.message,
      usage: turn.usage,
      tool_calls: turn.toolCalls,
      nested_tool_calls: turn.nestedToolCalls.length > 0 ? turn.nestedToolCalls : undefined,
      subagent_usage: hasSubUsage ? turn.subagentUsage : undefined,
      // Reuse the checkpointed assistant row (if the write succeeded) so the
      // tool rows + paired tool message attach to it rather than a duplicate.
      existing_message_id: turn.checkpoint?.messageId ?? undefined,
    };
    try {
      if (dbWriter) {
        await dbWriter.persistAssistantTurn(payload);
      } else {
        store.persistAssistantTurn(payload);
      }
    } catch (err) {
      // Non-fatal: the agent loop continues. The bus log is the authoritative
      // transcript and can be reconstructed if persistence fails for one turn.
      console.error(`[coder] persistAssistantTurn failed for session ${session.id}:`, err);
    }
    };
    // Preserve assistant/tool row order and let a compaction checkpoint await
    // every earlier fire-and-forget flush before reading the visible DB span.
    const scheduled = flushChain.then(persist, persist);
    flushChain = scheduled.catch(() => undefined);
    return scheduled;
  };

  // Interactive tool_use names the RESUME path can restore as a live card on
  // reopen (must match `findPendingInteraction` in coder/state.ts). Only these
  // are worth checkpointing: a PermissionGate pause (write_file/run_command) or
  // an execute_tasks budget ask would persist a dangling NON-interactive
  // tool_use that the dashboard renders as a stuck "running" spinner with no
  // approve affordance — worse than the pre-fix behavior (turn cleanly gone).
  const RESUMABLE_INTERACTIVE_TOOLS = new Set([
    // task_list(gate:'approve') is the canonical (bootstrap) route to the gated
    // pause — it dispatches to submitTasks' waitForUserInput and renders a real
    // TaskListReview approve card, so it MUST be checkpointed or the in-flight
    // approval is lost on reopen/restart. (findPendingInteraction already
    // matches task_list; this keeps the writer in sync with that reader.)
    'submit_plan', 'submit_tasks', 'task_list', 'ask_user', 'submit_spec', 'submit_specification_to_master',
  ]);
  const hasResumableInteractiveToolUse = (msg: AgentMessage): boolean =>
    Array.isArray(msg.content) &&
    msg.content.some((b) => b.type === 'tool_use' && RESUMABLE_INTERACTIVE_TOOLS.has(b.name));

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
        message: turn.message,
        usage: null,
        tool_calls: [],
      };
      try {
        cp.messageId = dbWriter
          ? await dbWriter.persistAssistantTurn(payload)
          : store.persistAssistantTurn(payload);
      } catch (err) {
        // Non-fatal: drop the checkpoint so the end-of-turn flush inserts fresh.
        turn.checkpoint = undefined;
        console.error(`[coder] checkpointPendingTurn failed for session ${session.id}:`, err);
      }
    })();
  };
  runner.on('awaiting_input', () => { checkpointPendingTurn(); });

  runner.on('tool_call_start', (id, name, input) => {
    pendingToolCalls.set(id, { name, input });
  });

  runner.on('message_complete', (message, usage) => {
    if (message.role !== 'assistant') return;
    // A new assistant message replaces any prior buffered turn that had no
    // tool calls (e.g., a pure-text turn). Persist the prior one first.
    flushPendingTurn();
    pendingTurn = {
      message,
      usage: usage ?? null,
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
  if (process.env.CODER_NESTED_TELEMETRY_DISABLE !== '1') {
    runner.on('nested_tool_call', (e) => {
      try {
        if (!pendingTurn) return;
        pendingTurn.nestedToolCalls.push({
          // Blocking nested calls carry their invocation-order id explicitly.
          // Prefer it over completion-order `seq` so a propagated parent row
          // can point at the exact root-cause audit row under concurrency.
          // Reuse/shadow rows keep a unique completion id and store their
          // cause separately in guard_origin_tool_use_id.
          tool_use_id:
            e.guardVerdict?.action === 'block' && e.guardVerdict.originToolUseId
              ? e.guardVerdict.originToolUseId
              : `${e.parentToolUseId}#${e.seq}`,
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
  }

  runner.on('tool_call_result', (id, name, result, durationMs) => {
    // Error-streak tracker for auto-captured "Fixed: <tool>" notes. Cheap,
    // best-effort, and independent of the telemetry buffering below.
    const capturedMilestone = autoCapture.onToolResult(
      name,
      Boolean(result.isError),
      result.isError ? String(result.content ?? '').slice(0, 200) : '',
      runnerRef?.turn ?? 0,
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
  // `persistAssistantTurn` writes the assistant message, the tool_calls audit
  // rows, AND the paired 'tool' role message in a single transaction (see
  // store/messages.ts), so there is no separate tool-message flush to keep in
  // sync. The previous approach scanned `runner.messages` from an integer
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
  // pair we align that summarized head with the visible DB prefix and append
  // the chapter + boundary atomically. There is no history_compacted-triggered
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
        const committed = persistChapterCheckpoint({
          store,
          sessionId: session.id,
          summary: checkpoint.summary,
          headMessages: checkpoint.headMessages,
          source: 'auto',
          chapterKind: checkpoint.trigger?.startsWith('milestone:') ? 'milestone' : 'context',
          trigger: checkpoint.trigger ?? 'context_threshold',
          chaptersEnabled: process.env.CODER_CONVERSATION_CHAPTERS !== '0',
          autoContinues: checkpoint.autoContinues,
        });
        const accepted = committed.status === 'committed'
          || committed.status === 'compatibility'
          || (committed.status === 'noop' && committed.reason === 'already_committed');
        if (!accepted) {
          return {
            status: committed.status === 'noop' ? 'noop' : 'failed',
            boundaryId: committed.boundary_id,
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
            boundaryId: committed.boundary_id,
            trigger: 'compaction',
          });
        }
        return {
          status: committed.status === 'compatibility' ? 'compatibility' : 'committed',
          chapterId: 'chapter' in committed ? committed.chapter?.id ?? null : null,
          boundaryId: committed.boundary_id,
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
      const attemptId = store.startCompactionAttempt({
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
      store.finishCompactionAttempt(attemptId, {
        status: retried.status === 'committed' || retried.status === 'compatibility'
          ? 'summarized'
          : retried.status === 'disabled'
            ? 'noop'
            : 'checkpoint_failed',
        strategy: 'summarizer',
        summarizer_ran: false,
        history_chars_after: chars,
        chapter_id: retried.chapterId ?? null,
        boundary_id: retried.boundaryId ?? null,
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

  const donePromise = runner
    .run()
    .then(async (res) => {
      await flushPendingTurn();
      await checkpointCoordinator.retry(runner.turn, true);
      // Terminal Quality runs after the runner emitted `done` (the response is
      // already visible) but before this handle resolves and the worker is
      // released. Exactly one provider attempt; no subagent/abort/error calls.
      try {
        const roundMessageId = runner.roundMessageId;
        const terminal = runner.getTerminalQualityContext();
        const changedFiles = roundMessageId == null
          ? []
          : snapshotStore
              .listRoundSnapshots('coder', session.id, roundMessageId, { includeClosed: true })
              .map((row) => row.file_path);
        await runTerminalQualityAssessment({
          reason: res.reason,
          isSubagent: runner.isSubagent,
          sessionId: session.id,
          companySessionId: opts.companyContext?.companySessionId ?? null,
          agentRunId: opts.companyContext?.agentRunId ?? null,
          coderRunId: runner.runId,
          roundMessageId,
          taskText: terminal.taskText || opts.userMessage,
          outputText: terminal.outputText,
          changedFiles,
          toolSummary: terminal.toolSummary,
          guardActions: terminal.guardActions,
          validationSignals: terminal.validationSignals,
        });
      } catch (error) {
        console.warn(`[quality] terminal assessment skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      store.updateSessionStatus(session.id, res.reason === 'error' ? 'error' : 'idle');
      return { reason: res.reason, usage: res.totalUsage, error: lastRunnerError?.message };
    })
    .catch(async (e) => {
      await flushPendingTurn();
      await checkpointCoordinator.retry(runner.turn, true);
      store.updateSessionStatus(session.id, 'error');
      throw e;
    })
    .finally(async () => {
      // Drain any pending async writes for THIS session before closing the
      // local DB handles. The writer is a process-wide singleton with its
      // own connection — it is not closed here, only on process shutdown.
      if (dbWriter) await dbWriter.drainSession(session.id);
      await mcpServerManager.closeAll();
      await bridge.close();
      for (const b of extraBridges) await b.close();
      // Sticky toolset (mig 142): capture pins earned mid-run (hidden tools
      // the model called by name get pinned at dispatch) before the store
      // closes, so the next resume rebuilds the same tool array.
      if (stickyToolset && runner.pinnedTools.size > 0) {
        const earnedPins = [...runner.pinnedTools].filter((name) => !configuredInitialPins.has(name));
        if (earnedPins.length > 0) {
          try { store.mergeSessionToolsetState(session.id, { addPins: earnedPins }); } catch { /* best-effort */ }
        }
      }
      // Phase 2: `store`, `db` and `skillStore` all share ONE process-wide
      // central connection now (getSharedCentral). They are NOT closed per-run —
      // a concurrent subordinate run shares the same handle. closeSharedCentral()
      // (worker stop handler) + the process-exit hook close it once on teardown.
    });

  return { session, runner, done: donePromise, indexStatus };
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
export { SessionStore } from '@mcp/code-agent/sessions/store.js';
export type { CoderSession } from '@mcp/code-agent/sessions/types.js';
export type { CoderProviderName } from '@mcp/code-agent/providers/adapter.js';
/**
 * Backwards-compatible alias used by HTTP admin routes. Derived dynamically
 * from the unified registry — all kinds that declare `createCoder`.
 */
export { listCoderKinds as SUPPORTED_CODER_PROVIDERS } from '@mcp/services/providers/factory.js';
