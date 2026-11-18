/**
 * @mcp/api-bus — transport-agnostic RPC contract for the MCP backend.
 *
 * Defines the shape of every operation the renderer (or any client) can
 * invoke. The same interfaces are mounted by:
 *   - Electron `ipcMain.handle` + `MessageChannel` (in-process, primary)
 *   - Hono HTTP/SSE routes (browser dev mode, debug, MCP_DEV_HTTP=1)
 *
 * Handlers live in `@mcp/api-handlers` and import this package for types.
 *
 * NOTE: Many shapes are deliberately loose (`unknown`, partial typing).
 * The api-bus is the stable contract; handlers refine. As feature areas
 * stabilize, types tighten here.
 */

import type { CoderApi } from './coder.js';
import type { ProjectsApi } from './projects.js';
import type { FilesApi } from './files.js';
import type { LspApi } from './lsp.js';
import type { EditorApi } from './editor.js';
import type { TerminalApi } from './terminal.js';
import type { SshApi } from './ssh.js';
import type { DbClientApi } from './dbClient.js';
import type { RunnerApi } from './runner.js';
import type { DebugApi } from './debug.js';
import type { RuntimeApi } from './runtime.js';
import type { SnapshotsApi } from './snapshots.js';
import type { SearchApi } from './search.js';
import type { AdminApi } from './admin.js';
import type { DocsApi } from './docs.js';
import type { CompanyApi } from './company.js';
import type { WorkspaceApi } from './workspace.js';
import type { ProjectGitApi } from './projectGit.js';
import type { AuthApi } from './auth.js';
import type { BillingApi } from './billing.js';
import type { PluginsApi } from './plugins.js';
import type { SystemApi } from './system.js';
import type {
  CostsApi,
  DiffApi,
  GraphApi,
  StatsApi,
  ModelsApi,
  TelemetryApi,
  HygieneApi,
  ExportApi,
  WebhooksApi,
  ConfigApi,
  PreviewAuthApi,
} from './misc.js';

export * from './common.js';
export * from './electron-bridge.js';
export * from './coder.js';
export * from './coder-session-workbench.js';
export * from './coder-session-workbench-validation.js';
export * from './projects.js';
export * from './files.js';
export * from './lsp.js';
export * from './editor.js';
export * from './terminal.js';
export * from './ssh.js';
export * from './dbClient.js';
export * from './runner.js';
export * from './debug.js';
export * from './runtime.js';
export * from './snapshots.js';
export * from './search.js';
export * from './admin.js';
export * from './docs.js';
export * from './company.js';
export * from './workspace.js';
export * from './projectGit.js';
export * from './auth.js';
export * from './billing.js';
export * from './plugins.js';
export * from './system.js';
export * from './misc.js';

/**
 * The aggregate contract — every namespace exposed by the backend.
 *
 * In Electron: `window.electronAPI.api: Api` (renderer side).
 * In handlers: same shape, fulfilled by `@mcp/api-handlers`.
 */
export interface Api {
  // Core IDE operations
  coder: CoderApi;
  projects: ProjectsApi;
  files: FilesApi;
  lsp: LspApi;
  editor: EditorApi;
  terminal: TerminalApi;
  ssh: SshApi;
  dbClient: DbClientApi;
  runner: RunnerApi;
  debug: DebugApi;
  runtime: RuntimeApi;

  // Project artifacts
  snapshots: SnapshotsApi;
  search: SearchApi;

  // Pro features
  docs: DocsApi;
  company: CompanyApi;
  workspace: WorkspaceApi;

  // Local git (project root_path, not sandbox)
  projectGit: ProjectGitApi;

  // Account
  auth: AuthApi;
  billing: BillingApi;

  // Plugins / marketplace
  plugins: PluginsApi;

  // Desktop shell: first-run preflight + guided Podman setup
  system: SystemApi;

  // Operational
  admin: AdminApi;
  costs: CostsApi;
  diff: DiffApi;
  graph: GraphApi;
  stats: StatsApi;
  models: ModelsApi;
  telemetry: TelemetryApi;
  hygiene: HygieneApi;
  export: ExportApi;
  webhooks: WebhooksApi;
  config: ConfigApi;
  previewAuth: PreviewAuthApi;
}

/**
 * Namespaces a renderer hook should typically declare it depends on.
 * Purely a documentation type — has no runtime effect.
 */
export type ApiNamespace = keyof Api;
export type { CoderWorktree, CoderWorktrees, CoderWorktreeRemoval } from './coder-worktrees.js';

export type { ChatNetworkConfig, ChatCompletion, ChatTrigger, ChatSpawnInput, ChatNetworkSnapshot, ChatNetworkPolicySnapshot } from '@mcp/agent-runtime-contracts/chat-network.js';
export type { PromptSuggestion, TaskProposal, ScheduledTrigger, ScheduledOccurrence } from '@mcp/agent-runtime-contracts';
