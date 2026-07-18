/**
 * Runtime contribution types for the authoring SDK. Plain interfaces, zero
 * deps (no zod) — so a plugin bundle that imports `definePlugin`/`contributeX`
 * stays lean. The declarative subset of each shape mirrors the `.app.json`
 * manifest schema; the CLI `build` step extracts it (dropping handlers).
 */
import type {
  PluginFs,
  PluginExec,
  PluginStorage,
  PluginPermissions,
} from './capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

/** What a plugin tool handler returns. The host maps it to the agent's ToolResult. */
export interface PluginSourceTruncation {
  technique: string;
  inputSize: number;
  /** False when inputSize is a lower bound rather than an exact source size. */
  inputSizeExact?: boolean;
  outputSize: number;
  unit: 'chars' | 'bytes' | 'lines' | 'rows' | 'items';
  recoverable: boolean;
}

export interface PluginToolResult {
  /** Human/agent-readable summary (what the LLM sees). */
  content: string;
  isError?: boolean;
  /**
   * Optional STRUCTURED payload for a plugin's OWN webview to render richly
   * (tables, cards, grids) instead of parsing `content`. The agent never sees
   * this — it's stripped from the agent-facing ToolResult and only delivered
   * through `plugins.invokeTool` to the plugin's iframe. JSON-serializable.
   */
  data?: unknown;
  /** Explicit producer-side omission metadata; the host never infers this from content text. */
  sourceTruncations?: PluginSourceTruncation[];
}

/** Restricted context handed to a tool handler. Runs inside the plugin worker. */
export interface PluginToolContext {
  projectName: string | null;
  cwd: string;
  signal?: AbortSignal;
  /** Surface a log line to the host (shows in plugin diagnostics). */
  log(message: string): void;
  /** Network access — handlers get fetch but no fs/child_process. */
  fetch: typeof fetch;
  /** Reverse-RPC to whitelisted host api-bus methods (read-only surface). */
  host: { invoke(method: string, payload?: unknown): Promise<unknown> };
  /** Project-scoped filesystem — present only if `fs` permission was granted. */
  fs?: PluginFs;
  /** Allowlisted one-shot command runner — present only with `exec` permission. */
  exec?: PluginExec;
  /** Per-plugin key-value storage — present only with `storage` permission. */
  storage?: PluginStorage;
}

export type PluginToolHandler = (
  args: Record<string, unknown>,
  ctx: PluginToolContext,
) => Promise<PluginToolResult> | PluginToolResult;

export interface ContributedTool {
  name: string;
  description: string;
  /** JSON Schema object describing the tool input. */
  parameters: Record<string, unknown>;
  riskLevel?: 'read' | 'write' | 'execute' | 'admin';
  mutates?: boolean;
  /**
   * Optional project/module activation. When present, the host only exposes the
   * tool to an agent run whose project root matches the rule.
   */
  activation?: ActivationRule;
  handler: PluginToolHandler;
}

/**
 * Declarative activation rule: when should this contribution show for a given
 * project? Evaluated by the HOST (no plugin code runs) against the project
 * root. Omit it entirely to always show. Any matching condition activates
 * (OR semantics). Mirrors VS Code's activationEvents/`when`.
 */
export interface ActivationRule {
  /** Show if ANY of these files exist at the project root (exact name or `*.ext`). */
  whenFiles?: string[];
  /** Show if package.json has ANY of these as a (dev)dependency. */
  whenPackageDep?: string[];
}

export interface ContributedToolWindow {
  id: string;
  title: string;
  icon?: string;
  side: 'left' | 'right' | 'bottom';
  /** Relative path to the HTML entry rendered in a sandboxed iframe. */
  entry: string;
  /**
   * Optional auto-detection: only surface this window when the open project
   * matches (e.g. a Cloudflare plugin shows only when a wrangler config or the
   * `wrangler` dep is present). Omit to always show.
   */
  activation?: ActivationRule;
}

export interface ContributedCommand {
  id: string;
  label: string;
  category?: string;
  shortcut?: string;
  /** When set, running the command invokes this contributed tool by name. */
  runsTool?: string;
}

export interface ContributedTheme {
  id: string;
  label: string;
  appearance: 'dark' | 'light';
  /** CSS variable overrides, e.g. `{ '--primary': '#4d8cff' }`. */
  tokens: Record<string, string>;
}

export type PluginContributionScope = 'application' | 'editor' | 'project' | 'module';

export interface ContributedEditorAction {
  id: string;
  label: string;
  category?: string;
  icon?: string;
  shortcut?: string;
  /**
   * Invoke a contributed tool by name. The host binds project/module context at
   * runtime, so actions stay declarative.
   */
  runsTool?: string;
  scope?: Extract<PluginContributionScope, 'editor' | 'project' | 'module'>;
  activation?: ActivationRule;
}

export interface ContributedStatusBarItem {
  id: string;
  label: string;
  tooltip?: string;
  icon?: string;
  alignment?: 'left' | 'right';
  priority?: number;
  runsTool?: string;
  scope?: Extract<PluginContributionScope, 'application' | 'project' | 'module'>;
  activation?: ActivationRule;
}

export interface ContributedRunConfiguration {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  kind?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  scope?: Extract<PluginContributionScope, 'project' | 'module'>;
  activation?: ActivationRule;
}

/**
 * A project module/facet in the IntelliJ sense: a detected slice of a project
 * with its own actions, run configs and UI. Tool handlers still live in the
 * plugin worker; this shape only declares where the host should surface them.
 */
export interface ContributedProjectModule {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  activation: ActivationRule;
  tools?: string[];
  toolWindows?: ContributedToolWindow[];
  editorActions?: ContributedEditorAction[];
  statusBarItems?: ContributedStatusBarItem[];
  runConfigurations?: ContributedRunConfiguration[];
}

export interface PluginModule {
  tools: ContributedTool[];
  toolWindows: ContributedToolWindow[];
  commands: ContributedCommand[];
  themes: ContributedTheme[];
  editorActions: ContributedEditorAction[];
  statusBarItems: ContributedStatusBarItem[];
  runConfigurations: ContributedRunConfiguration[];
  modules: ContributedProjectModule[];
  /** Capabilities the plugin requires (fs/exec/storage). Extracted to .app.json. */
  permissions?: PluginPermissions;
  /**
   * LLM provider metadata contributed by this plugin. Executable V2 ownership is
   * declared separately by exporting `providerAdapter`/`providerAdapters` from
   * the plugin bundle; the CLI records that as `.app.json.providerRuntime`.
   */
  providers?: ProviderSpec[];
}
