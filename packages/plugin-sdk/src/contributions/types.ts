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

export interface PluginModule {
  tools: ContributedTool[];
  toolWindows: ContributedToolWindow[];
  commands: ContributedCommand[];
  themes: ContributedTheme[];
  /** Capabilities the plugin requires (fs/exec/storage). Extracted to .app.json. */
  permissions?: PluginPermissions;
  /**
   * LLM providers contributed by this plugin — each a declarative
   * `@mcp/provider-sdk` ProviderSpec (pure DATA, no functions). The CLI `build`
   * step writes the spec verbatim into `.app.json`; the host turns it into a
   * runtime definition via `buildProviderDefinition` — NO plugin code runs
   * in-process. A new wire/auth is a first-party engine change, never plugin data.
   */
  providers?: ProviderSpec[];
}
