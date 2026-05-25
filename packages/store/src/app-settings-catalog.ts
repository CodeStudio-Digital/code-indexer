/**
 * App settings catalog — the curated list of `process.env.*` knobs we
 * expose in the admin "Configurações" panel.
 *
 * Why a catalog (vs free-form key/value):
 *
 *   - **Discoverability**: 200+ env vars hide across the codebase; the
 *     catalog tells the operator what's actually configurable without
 *     grepping source.
 *   - **Typed editing**: a boolean gets a Switch, an int gets a number
 *     input with range validation, a URL gets an Input with hint.
 *   - **Categorisation**: the rail/subgroups in the UI come from
 *     `category` here.
 *   - **Restart marker**: some envs (port, worker mode) require a
 *     backend restart to take effect — we surface that next to the
 *     input so the operator isn't surprised.
 *   - **Secrets**: API keys never display the value (password mask)
 *     and audit logs treat them differently.
 *
 * Add a new env in 3 places:
 *   1. Drop a `SettingDef` entry below in the appropriate category.
 *   2. Make sure the code reading the env tolerates an empty string
 *      (the DB stores it as such when the user clears the field).
 *   3. If the change requires more than a `process.env[K] = v` (e.g.,
 *      port flip → server reboot), set `restartNeeded: true`.
 *
 * NOT in this catalog:
 *   - Provider API keys + base URLs (live in the providers panel, with
 *     encryption-aware UX — we don't duplicate them here).
 *   - SDK internals (`CLAUDE_CODE_*`) — those belong to the @anthropic
 *     SDK; operators shouldn't tune them via our UI.
 *   - OS / Node basics (`NODE_ENV`, `CI`, `AWS_REGION`) — set those at
 *     the OS level if needed.
 */

export type SettingType = 'string' | 'bool' | 'int' | 'float' | 'url' | 'secret';
export type SettingCategory = 'llm' | 'mcp' | 'agent' | 'company' | 'debug';

export interface SettingDef {
  /** The env-var name as referenced in `process.env`. */
  key: string;
  /** Short label for the input row. */
  label: string;
  /** One-liner help text rendered as muted-fg below the label. */
  description: string;
  type: SettingType;
  category: SettingCategory;
  /** Fallback used when neither the DB nor process.env has a value. */
  default?: string;
  /**
   * When true, the input is grouped behind an "Advanced" toggle so the
   * default landing page stays focused on the 10-15 settings most
   * operators actually touch.
   */
  advanced?: boolean;
  /**
   * When true, the admin UI shows "Restart needed" next to this row
   * and the "Restart backend" button at the top of the section enables
   * once any restart-needed setting is dirty.
   */
  restartNeeded?: boolean;
  /** Min/max for int/float inputs — surface clamp range hints. */
  min?: number;
  max?: number;
  /** Enum-style string. Renders a Select instead of a free Input. */
  options?: readonly string[];
}

export const APP_SETTINGS: readonly SettingDef[] = [
  // ─── LLM ──────────────────────────────────────────────────────────
  {
    key: 'ZAI_MAX_TOKENS',
    label: 'Z.AI max output tokens',
    description: 'Cap on completion length for GLM models. 32000 covers most coding tasks.',
    type: 'int',
    category: 'llm',
    default: '32000',
    min: 1,
    max: 131072,
  },
  {
    key: 'BRAVE_API_KEY',
    label: 'Brave Search API key',
    description: 'Powers the agent\'s web_search tool. Get a key at brave.com/search/api.',
    type: 'secret',
    category: 'llm',
  },
  {
    key: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    label: 'Anthropic Sonnet model id',
    description: 'Override the default `claude-sonnet-*` model id used by Anthropic-backed sessions.',
    type: 'string',
    category: 'llm',
    advanced: true,
  },
  {
    key: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    label: 'Anthropic Opus model id',
    description: 'Override the default `claude-opus-*` model id.',
    type: 'string',
    category: 'llm',
    advanced: true,
  },
  {
    key: 'ANTHROPIC_SMALL_FAST_MODEL',
    label: 'Anthropic small/fast model id',
    description: 'Used by sub-agents and other cheap calls. Defaults to claude-haiku.',
    type: 'string',
    category: 'llm',
    advanced: true,
  },

  // ─── MCP ──────────────────────────────────────────────────────────
  {
    key: 'MCP_DEV_HTTP',
    label: 'Expose Hono dev HTTP listener',
    description:
      'Binds the in-process API to 127.0.0.1:3333 so you can hit endpoints from curl / a second tool. Off by default; the IDE uses mcp:// in-process dispatch instead.',
    type: 'bool',
    category: 'mcp',
    default: '0',
    restartNeeded: true,
  },
  {
    key: 'MCP_CODER_WORKER',
    label: 'Run coder in a worker thread',
    description:
      'Isolates each chat session in its own worker_thread. Improves crash recovery + parallelism; off for fewer moving parts in dev.',
    type: 'bool',
    category: 'mcp',
    default: '0',
    restartNeeded: true,
  },
  {
    key: 'MCP_CODER_WORKER_DEBUG',
    label: 'Verbose worker logs',
    description: 'Dumps RPC + bus event breadcrumbs on worker crashes. Only useful with worker mode on.',
    type: 'bool',
    category: 'mcp',
    default: '0',
    advanced: true,
  },
  {
    key: 'MCP_CODER_WORKER_STRICT_CRASH',
    label: 'Strict worker crash policy',
    description:
      'Kills the worker on EVERY uncaught error (vs the default "keep alive on transient network errors"). Use when chasing a recurring bug.',
    type: 'bool',
    category: 'mcp',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_WORKER_TTL_MS',
    label: 'Worker idle TTL (ms)',
    description: 'How long an idle coder worker stays alive before eviction. Default 5 minutes.',
    type: 'int',
    category: 'mcp',
    default: '300000',
    min: 30_000,
    advanced: true,
  },
  {
    key: 'CODER_WORKER_POST_RUN_LINGER_MS',
    label: 'Worker post-run linger (ms)',
    description: 'Window the worker waits for a follow-up message before evicting. Default 30s.',
    type: 'int',
    category: 'mcp',
    default: '30000',
    min: 0,
    advanced: true,
  },

  // ─── Agent — behaviour ─────────────────────────────────────────────
  {
    key: 'CODER_PROFILE',
    label: 'Default coder profile',
    description: 'Which tool tiers start active. `auto` picks based on the user\'s first message.',
    type: 'string',
    category: 'agent',
    options: ['auto', 'bootstrap', 'navigate', 'full'],
  },
  {
    key: 'CODER_PROFILE_AUTO',
    label: 'Auto-profile from first message',
    description: 'Inspect the first user message to pick bootstrap/navigate/full when profile is unset.',
    type: 'bool',
    category: 'agent',
    default: '0',
  },
  {
    key: 'CODER_MAX_AUTO_CONTINUES',
    label: 'Max auto-continues per turn',
    description: 'How many times the runner can auto-continue after a tool result without a user message.',
    type: 'int',
    category: 'agent',
    default: '40',
    min: 1,
  },
  {
    key: 'CODER_IMPLEMENT_MAX_TURNS',
    label: 'Build mode max turns',
    description: 'Hard cap on turns in build/implement mode.',
    type: 'int',
    category: 'agent',
    default: '60',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_REVIEW_MAX_TURNS',
    label: 'Reviewer subagent max turns',
    description: 'Turns budget for `request_review` reviewer subagent.',
    type: 'int',
    category: 'agent',
    default: '12',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_PARALLEL_AGENT_MAX',
    label: 'Max parallel sub-agents',
    description: 'How many `spawn_agents` workers can run concurrently.',
    type: 'int',
    category: 'agent',
    default: '4',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_DISABLE_SUBAGENTS',
    label: 'Disable sub-agents entirely',
    description: 'Forces `spawn_subagent` / `spawn_agents` to refuse with an explanatory error.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_AGENTLESS_MODE',
    label: 'Agentless mode',
    description: 'Pre-Agent-Loop-v2 behaviour. Mostly for regression testing.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_AGENT_LOOP_V2',
    label: 'Agent Loop v2',
    description: 'Newer turn-management loop with dedup + protect-window heuristics. ON by default in newer builds.',
    type: 'bool',
    category: 'agent',
    default: '1',
    advanced: true,
  },
  {
    key: 'CODER_NEW_COMPACTION',
    label: 'New compaction strategy',
    description: 'Use the rolling-window compactor (vs the legacy summarizer).',
    type: 'bool',
    category: 'agent',
    default: '1',
    advanced: true,
  },
  {
    key: 'CODER_PROMPTS_WATCH',
    label: 'Hot-reload system prompts',
    description:
      'Watch packages/code-agent/src/prompts/*.txt and rebuild the system prompt on save. Useful when iterating on prompt copy.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_FALLBACK_CHAIN',
    label: 'Provider fallback chain',
    description: 'Comma-separated provider ids to try in order when the primary 5xx/429s.',
    type: 'string',
    category: 'agent',
    advanced: true,
  },

  // ─── Agent — loop guards (Advanced) ────────────────────────────────
  {
    key: 'CODER_DOOM_LOOP_THRESHOLD',
    label: 'Strict doom-loop threshold',
    description: 'Abort run after N identical tool-call sets in a row. 0 disables.',
    type: 'int',
    category: 'agent',
    default: '3',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_DOOM_LOOP_FUZZY_THRESHOLD',
    label: 'Fuzzy doom-loop threshold',
    description: 'Abort run after N same-tool-name calls in a row (any args).',
    type: 'int',
    category: 'agent',
    default: '6',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_DOOM_LOOP_DEBUG',
    label: 'Doom-loop debug logs',
    description: 'Emit `[doom-loop-debug]` lines around each guard push/check.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_DUP_CALL_THRESHOLD',
    label: 'Per-arg dup-call threshold',
    description: 'Refuse a tool call when the same (name, args) hash has been called N times in the window.',
    type: 'int',
    category: 'agent',
    default: '5',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_DUP_CALL_WINDOW',
    label: 'Per-arg dup-call window',
    description: 'Rolling window (turns) over which dup-call threshold is counted.',
    type: 'int',
    category: 'agent',
    default: '20',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_RESULT_DUP_THRESHOLD',
    label: 'Result-content dedup threshold',
    description: 'Refuse a tool result whose content matches a previous result in the window.',
    type: 'int',
    category: 'agent',
    default: '1',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_RESULT_DUP_WINDOW',
    label: 'Result-content dedup window',
    description: 'Window size in turns for the dedup check.',
    type: 'int',
    category: 'agent',
    default: '6',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_RESULT_DUP_MIN_CHARS',
    label: 'Result dedup min chars',
    description: 'Ignore dedup on results shorter than this.',
    type: 'int',
    category: 'agent',
    default: '512',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_READ_DUP_THRESHOLD',
    label: 'read_file dup threshold',
    description: 'Refuse `read_file` when the same path was read N times in the window.',
    type: 'int',
    category: 'agent',
    default: '3',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_READ_DUP_WINDOW',
    label: 'read_file dup window',
    description: 'Window size in turns for the read_file dedup check.',
    type: 'int',
    category: 'agent',
    default: '10',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_DOMINANCE_RATIO',
    label: 'Dominance guard ratio',
    description: 'Abort run when one tool exceeds this fraction of all calls in a window.',
    type: 'float',
    category: 'agent',
    default: '0.75',
    min: 0,
    max: 1,
    advanced: true,
  },
  {
    key: 'CODER_DOMINANCE_WINDOW',
    label: 'Dominance window',
    description: 'Turn window for dominance-ratio check.',
    type: 'int',
    category: 'agent',
    default: '8',
    min: 1,
    advanced: true,
  },

  // ─── Agent — output caps (Advanced) ────────────────────────────────
  {
    key: 'CODER_READ_FILE_HARD_MAX',
    label: 'read_file hard max bytes',
    description: 'Maximum file size that read_file returns. Above this it errors with a hint.',
    type: 'int',
    category: 'agent',
    default: '524288',
    min: 1024,
    advanced: true,
  },
  {
    key: 'CODER_READ_FILE_AUTOFULL_DISABLE',
    label: 'Disable read_file auto-full',
    description: 'When set, agent must always pass an explicit range to read_file.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_GREP_PER_FILE_CAP',
    label: 'grep matches-per-file cap',
    description: 'Cap matches per file in `grep_code` output to keep one hot file from drowning results.',
    type: 'int',
    category: 'agent',
    default: '10',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_MCP_DEFAULT_MAX_TOKENS',
    label: 'MCP tool default max_tokens',
    description: 'Default max_tokens budget for MCP tool calls (e.g., mcp__search).',
    type: 'int',
    category: 'agent',
    default: '4096',
    min: 256,
    advanced: true,
  },
  {
    key: 'CODER_MCP_OUTPUT_HARD_CAP',
    label: 'MCP tool output hard cap',
    description: 'Hard ceiling on chars returned by ANY mcp__* tool, regardless of caller-set limits.',
    type: 'int',
    category: 'agent',
    default: '40000',
    min: 1024,
    advanced: true,
  },
  {
    key: 'CODER_AUTOCOMPACT_BUFFER',
    label: 'Auto-compact buffer (tokens)',
    description: 'When remaining context falls below this, trigger compaction.',
    type: 'int',
    category: 'agent',
    default: '20000',
    min: 1000,
    advanced: true,
  },
  {
    key: 'CODER_COMPACT_PRESERVE_LAST_N_TURNS',
    label: 'Compact preserve last N turns',
    description: 'Number of recent turns left untouched during compaction.',
    type: 'int',
    category: 'agent',
    default: '4',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_REPOMAP_TOKENS',
    label: 'repomap budget (tokens)',
    description: 'Token budget for the auto-generated project repomap on turn 1.',
    type: 'int',
    category: 'agent',
    default: '1024',
    min: 0,
    advanced: true,
  },

  // ─── Company / Subagent (Advanced) ─────────────────────────────────
  {
    key: 'CODER_COMPANY_IDLE_TIMEOUT_MS',
    label: 'Company idle timeout (ms)',
    description: 'Time a company subordinate can sit idle before the orchestrator evicts it.',
    type: 'int',
    category: 'company',
    default: '600000',
    min: 60_000,
    advanced: true,
  },
  {
    key: 'CODER_COMPANY_MAX_SUBORDINATES',
    label: 'Max concurrent subordinates',
    description: 'How many subordinate workers the orchestrator may host at once.',
    type: 'int',
    category: 'company',
    default: '6',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_COMPANY_ORCHESTRATOR_TTL_MS',
    label: 'Orchestrator TTL (ms)',
    description: 'Idle TTL for the orchestrator host itself.',
    type: 'int',
    category: 'company',
    default: '1800000',
    min: 60_000,
    advanced: true,
  },

  // ─── Debug ─────────────────────────────────────────────────────────
  {
    key: 'CODER_LOG_TOOLS_COUNT',
    label: 'Log tool count per turn',
    description: 'Emits `[coder] N tools registered` on every turn so you can verify tier promotion.',
    type: 'bool',
    category: 'debug',
    default: '0',
  },
  {
    key: 'CODER_DISABLED_MCP_TOOLS',
    label: 'Disabled MCP tools',
    description: 'Comma-separated `mcp__*` tool names to hide from the registry. Useful to A/B a tool.',
    type: 'string',
    category: 'debug',
    advanced: true,
  },
  {
    key: 'CODER_MODEL_CAPS',
    label: 'Model capability overrides',
    description: 'JSON map of model id → capability flags. Advanced; see docs.',
    type: 'string',
    category: 'debug',
    advanced: true,
  },
];

/**
 * Index-by-key lookup for O(1) access during SettingStore reads.
 */
const BY_KEY = new Map<string, SettingDef>(APP_SETTINGS.map((d) => [d.key, d]));

export function getSettingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

/** All categories, in display order. */
export const SETTING_CATEGORIES: readonly { id: SettingCategory; label: string }[] = [
  { id: 'llm', label: 'LLM & API keys' },
  { id: 'mcp', label: 'MCP & workers' },
  { id: 'agent', label: 'Agent behaviour' },
  { id: 'company', label: 'Company / multi-agent' },
  { id: 'debug', label: 'Debug & logging' },
];
