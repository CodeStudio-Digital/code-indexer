import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider, CoderProviderName } from '@mcp/code-agent/providers/adapter.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { CoderProfile } from '@mcp/code-agent/tools/tiers.js';
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import type { CoderSession } from '@mcp/code-agent/sessions/types.js';

export interface CoderAttachment {
  name: string;
  mediaType: string;
  /** Base64-encoded payload (for images and binary docs like PDF). */
  base64?: string;
  /** Pre-decoded UTF-8 text (for plain-text-like files). */
  text?: string;
}

export interface RunCoderOptions {
  /** Numeric session id (existing) or "new" to create one */
  session: { id: number } | { create: { project_id: number; title: string; provider: CoderProviderName; model?: string } };
  /** User message to append before running */
  userMessage: string;
  /** Optional attachments (images, documents) for the user message */
  attachments?: CoderAttachment[];
  /** Optional max turns (default 50) */
  maxTurns?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /**
   * Mem C — host-provided project-memory retriever. Structural type to avoid
   * a code-agent → services dependency. When set and the project has memory
   * enabled, runCoder wires it into `RunnerOptions.getRelevantProjectMemory`
   * so the runner proactively injects relevant memory each turn.
   */
  memoryRetriever?: {
    retrieve(
      projectId: number,
      projectName: string,
      taskText: string,
    ): Promise<ReadonlyArray<{ id: string; title: string; content: string; staleNote?: string }>>;
  };
  /**
   * Durable-memory write-back — host callback that distills durable project
   * memory (decisions/conventions/architecture + `gotcha` failure lessons)
   * from the FINISHED run and persists it, off the hot path. Structural to
   * avoid a code-agent → services dependency (mirrors `memoryRetriever`).
   * Invoked once in the run's done-block, gated on `memory_enabled`; the
   * runner assembles the raw signal via its own summarizer. Best-effort.
   */
  runEndMemory?: {
    extractAndPersist(
      projectId: number,
      projectName: string,
      input: {
        primaryRequest?: string;
        summary?: string;
        filesTouched?: string[];
        errorsAndFixes?: string[];
        toolTrail?: string[];
        succeeded?: boolean;
      },
    ): Promise<void>;
    /** True only when a distiller binding is configured — gate the costly
     *  end-of-run summary on this so unconfigured projects pay nothing. */
    isConfigured(): Promise<boolean>;
  };
  /** Plan mode: agent must call submit_plan and get approval before mutating tools. */
  planMode?: boolean;
  /**
   * Spec mode: agent must call `submit_spec` and get human approval before
   * mutating tools. Set automatically when `agent === 'spec'`; explicit
   * values win for tests and edge cases.
   */
  specMode?: boolean;
  /**
   * Agent preset — bundles profile + planMode + maxTurns for a common usage
   * pattern. Takes precedence over explicit `profile` / `planMode` when set.
   * See src/core/coder/agents/index.ts for the four built-in presets
   * (explore / plan / build / admin).
   */
  agent?: AgentId;
  /**
   * Tool tier profile. Restricts the tools array sent to the LLM per turn.
   * - 'bootstrap' (~13 tools): read/search/pulse only — default for new.
   * - 'navigate' (~33 tools): adds write/edit/git-read/deep nav.
   * - 'full' (all 57): legacy. Default for resumed sessions.
   * - 'auto': inferred from the first user message via a regex classifier.
   * The agent can unlock higher tiers mid-session via `expand_toolset`.
   */
  profile?: CoderProfile | 'auto';
  /**
   * Create and enter an isolated git worktree at session start. When set on
   * a fresh session (no prior `worktree_path` persisted), runCoder creates
   * `.mcp-indexer/worktrees/<name>/` and scopes the runner into it BEFORE
   * the first turn — so the agent sees the worktree as its cwd from the
   * very first tool call.
   *
   * - `name` (optional): worktree directory name. Auto-generated if omitted.
   * - `branch` (optional): branch to check out. Defaults to `coder/<name>`.
   *   Created from HEAD when it does not exist yet.
   *
   * The existing `enter_worktree` / `exit_worktree` admin-tier tools remain
   * available for mid-session pivots, but the primary path is to decide
   * "this session runs in a worktree" once at creation time.
   */
  worktree?: { name?: string; branch?: string };
  /**
   * Resume mode: do NOT push a new user message. Used when the dashboard
   * answered a pending submit_plan/ask_user after a server restart — the
   * tool_result was already appended by the API handler.
   */
  resume?: boolean;
  /** Enable thinking/reasoning mode for providers that support it. */
  thinking?: boolean;
  /**
   * Vision fallback (image → text). `modelSupportsVision === false` (strict)
   * tells the runner the active model can't see images, so image blocks are
   * routed through the configured `code-agent/vision` Pipelines model for an
   * agent-directed text description. `describeImages` is the composer
   * "Describe images" flag forcing the same path even on vision-capable
   * models. Both default undefined → disabled.
   */
  modelSupportsVision?: boolean;
  describeImages?: boolean;
  /**
   * Per-request thinking budget (in tokens). Forwarded to the runner via
   * `runner.opts.thinkingBudgetTokens` and into every `ChatRequest`.
   * Anthropic honours this as `thinking.budget_tokens`; other providers
   * ignore. When undefined the provider falls back to `defaultThinking`.
   */
  thinkingBudgetTokens?: number;
  /**
   * Simulated deepThink mode — orthogonal to `thinking`. When true, the
   * runner asks a cheap auxiliary model (default Haiku) to write a few
   * sentences of reasoning before each main-model turn and prefills them
   * as a `<thinking data-source="aux">` block.
   */
  deepThink?: boolean;
  /** Auxiliary model id. Default 'claude-haiku-4-5-20251001'. */
  deepThinkModel?: string;
  /** Auxiliary provider name. Default 'anthropic'. */
  deepThinkProvider?: string;
  /** When false (default), skip pre-think on tool_result turns. */
  preThinkOnToolResults?: boolean;
  /**
   * Per-session resolved tunables (push caps, turn budget, intervention
   * cooldown). When omitted, the runner falls back to `envTunables()`
   * → `process.env.CODER_*` with hardcoded defaults — bit-identical to
   * pre-A1 behavior.
   */
  tunables?: import('@mcp/code-agent/core/tunables.js').CoderTunables;
  /** Company orchestrator context — when present, company tools are registered. */
  companyContext?: import('@mcp/company/types.js').CompanyContext;
  /**
   * Whether the preview DevTools backend is available (the desktop app wired
   * a `PreviewWindowService`). When true the `preview` tool tier activates so
   * the agent can open a dedicated preview window + read console/network/etc.
   * Set by the caller (http-api) from the main-process service presence.
   */
  previewAvailable?: boolean;
  /**
   * Standalone sandbox binding (decoupled Builder sessions). When present,
   * the runner pins `cwd` to the container workdir and swaps in the
   * sandbox-backed filesystem/shell adapters — WITHOUT requiring a
   * `companyContext`. Takes precedence over `companyContext.sandbox`.
   */
  sandbox?: import('@mcp/company/types.js').SandboxBinding;
  /** Extra system prompt block for company agents (master/subordinate). Appended to base. */
  companyPromptBlock?: string;
  /** Role identity text (from template systemPromptOverride) re-injected after compaction. */
  companyRoleOverride?: string;
  /**
   * Per-role sampling temperature override (`CompanyRoleConfig.temperature`).
   * Forwarded to `CoderRunner` and consumed by `resolveTemperature`. Lower
   * precedence than per-session, higher than agent preset default.
   */
  roleTemperature?: number;
  /**
   * Resolver for OAuth bearer tokens of external MCP servers. When provided,
   * external servers with `auth_type='oauth2'` automatically receive
   * `Authorization: Bearer <access>` (with auto-refresh). When null/omitted,
   * OAuth servers connect unauthenticated.
   */
  mcpBearerResolver?: import('@mcp/services/mcp-client/auth/use-cases/resolve-mcp-bearer.js').ResolveMcpBearer | null;
  /**
   * Inject a pre-existing external-MCP manager instead of opening a fresh
   * connection set per run. The http-api wires this to a process-wide
   * `McpExternalPool` so every coder worker reuses one set of transports.
   */
  externalMcpManager?: import('@mcp/code-agent/tools/mcp-server-manager-interface.js').IMcpServerManager;
  /**
   * Tools contributed by installed plugins. Synthesized + worker-backed by
   * the http-api layer (see `@mcp/plugin-host` `buildPluginTools`) and passed
   * in per run. Registered at the tail of the registry like external MCP
   * tools. Omitted in CLI / test usage (no plugins loaded).
   */
  pluginTools?: import('@mcp/code-agent/core/tool.js').CoderTool[];
  /**
   * Phase 2 hardening: explicit escape hatch the policy module consults when
   * running in strict mode (Phase 5). Today reserved.
   */
  adminOverride?: boolean;
  /**
   * Synchronous hook fired right after the `CoderRunner` is constructed and
   * all internal listeners are attached, but BEFORE `runner.run()` is
   * called. Callers register listeners that must observe the very first
   * turn — e.g. company HumanInTheLoop's `question_posted` /
   * `plan_posted` / `tasks_posted` capture, which would otherwise miss an
   * `ask_user` made on turn 1.
   */
  onRunnerReady?: (runner: CoderRunner) => void;
  /**
   * Notification callback fired whenever the SnapshotRecorder captures (or
   * appends to) a baseline for a file the agent just mutated. Lets the HTTP
   * layer publish a `session_snapshot_changed` SSE event.
   */
  onSnapshotRecorded?: (info: { baselineId: number; filePath: string }) => void;
  /**
   * Optional per-turn tool-list filter (ToolSelectionPipeline runtime hook).
   * Built by `deps.buildToolSelectionFilter()` in the host. Forwarded
   * verbatim to `RunnerOptions.toolSelectionFilter`.
   */
  toolSelectionFilter?: import('@mcp/code-agent/core/runner.js').RunnerOptions['toolSelectionFilter'];
  /**
   * Skill IDs the user pre-selected in the chat sidebar. Persisted on the
   * first user message of this run (migration 095) and re-resolved by the
   * runner into an `<active_skills>` block on every turn.
   */
  selectedSkillIds?: string[];
}

export interface IndexStatus {
  isIndexed: boolean;
  mcpAvailable: boolean;
}

export interface RunCoderHandle {
  session: CoderSession;
  runner: CoderRunner;
  /** Awaits completion. Resolves with the run reason, usage, and optional error detail. */
  done: Promise<{ reason: string; usage: ChatUsage; error?: string }>;
  /** Whether the project is indexed and MCP tools were registered. */
  indexStatus: IndexStatus;
}

/**
 * Structured-clone-safe projection of `RunCoderHandle`. A live handle holds a
 * `runner` (EventEmitter) and a `done` Promise that can't survive
 * `structuredClone`, so methods that cross a worker boundary (e.g.
 * `CompanyOrchestrator.startMaster`) return this POJO summary instead.
 */
export interface MasterStartResult {
  masterSessionId: number;
  /**
   * Null when the master's `runCoder` hasn't booted yet — the company
   * start/resume path returns this ack as soon as the run is *registered*
   * and provisions the sandbox + boots the runner in the background, so
   * the index status isn't known at ack time. No company-path caller
   * reads it; the coder path computes its own status from the live handle.
   */
  indexStatus: IndexStatus | null;
}
