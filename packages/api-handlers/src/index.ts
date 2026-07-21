/**
 * @mcp/api-handlers — pure handler implementations of the `@mcp/api-bus`
 * contract. Mounted by both the Hono adapter and the Electron IPC bridge.
 *
 * Handlers are factories: `createXxxHandlers(deps): XxxApi`. They take
 * the same `ServerDeps` the Hono routes consume and return an object
 * that satisfies the bus interface.
 *
 * `createHandlers(deps)` returns the aggregate `Partial<Api>` — every
 * namespace whose handler factory has been wired so far. New factories
 * land here as they're extracted from Hono routes.
 */

import type { Api } from '@mcp/api-bus';
import { createProjectsHandlers } from './projects/index.js';
import { createFilesHandlers } from './files/index.js';
import { createTerminalHandlers } from './terminal/index.js';
import { createSshHandlers } from './ssh/index.js';
import { createDbClientHandlers } from './db-client/index.js';
import { createRunnerHandlers } from './runner/index.js';
import { createDebugHandlers } from './debug/index.js';
import { createRuntimeHandlers } from './runtime/index.js';
import { createCoderHandlers } from './coder/index.js';
import { createLspHandlers } from './lsp/index.js';
import { createEditorHandlers } from './editor/index.js';
import { createSnapshotsHandlers } from './snapshots/index.js';
import { createSearchHandlers } from './search/index.js';
import { createProjectGitHandlers } from './projectGit/index.js';
import { createPluginsHandlers } from './plugins/index.js';
import { createSystemHandlers } from './system/index.js';
import type { HandlerDeps } from './types.js';

export type { HandlerDeps } from './types.js';
export { createContext, createInternalContext } from './context.js';
export { createProjectsHandlers } from './projects/index.js';
export { runScaffoldStream } from './projects/scaffold.js';
export { runDsStudioScaffoldStream } from './design-system/studio-scaffold.js';
export type { DsStudioCreateInput, DsStudioStreamEvent } from './design-system/studio-scaffold.js';
export { runAppStudioScaffoldStream } from './app-studio/studio-scaffold.js';
export type {
  AppStudioCreateInput,
  AppStudioExecutionMode,
  AppStudioStreamEvent,
} from './app-studio/studio-scaffold.js';
export {
  canonicalAppTeamRole,
  createAppTeamSession,
  getAppTeamSession,
} from './app-studio/app-team-session.js';
export type {
  AppTeamSessionView,
  CreateAppTeamSessionResult,
} from './app-studio/app-team-session.js';
export { runWranglerLoginStream, runWranglerWhoami } from './app-studio/login-stream.js';
export type { AppCfLoginEvent, CfWhoami } from './app-studio/login-stream.js';
export { runAppLaunchStream } from './app-studio/launch-stream.js';
export type { AppLaunchEvent } from './app-studio/launch-stream.js';
export { reinstrumentBuilder, type ReinstrumentResult } from './projects/reinstrument.js';
export { visualEdit, type VisualEditBody, type VisualEditOkResult } from './projects/visual-edit.js';
export {
  linkDesignSystem,
  unlinkDesignSystem,
  linkDsToDir,
  type DsConsumerLink,
} from './projects/link-design-system.js';
export { createFilesHandlers } from './files/index.js';
export { createTerminalHandlers } from './terminal/index.js';
export { createSshHandlers, sharedSshManager, disposeSharedSshResources } from './ssh/index.js';
export { createDbClientHandlers } from './db-client/index.js';
export { createRunnerHandlers } from './runner/index.js';
export { createDebugHandlers, disposeDebugSessions, DebugSessionManager, DapConnection } from './debug/index.js';
export { sharedPtyManager } from './terminal/pty-manager.js';
export { createRuntimeHandlers } from './runtime/index.js';
export { disposeShellStreamProcesses } from './runtime/installers/shell-stream.js';
export { createCoderHandlers } from './coder/index.js';
export { createLspHandlers } from './lsp/index.js';
// Boot-time wiring: ensureLspManager wires the onDocEvent listener + the
// status hub before the first didOpen can arrive (closes the cold-start
// spawn race). Idempotent (module singleton + wired flag).
export { ensureLspManager } from './lsp/server-backend.js';
// lsp-worker plumbing: executor surface + holder + doc-store hooks the
// main-thread client (apps/http-api/sse) needs to mirror/replay buffers.
export { createInProcessLspExecutor } from './lsp/executor-inproc.js';
export { setLspExecutor, getLspExecutor } from './lsp/executor-holder.js';
export {
  EMPTY_RESULTS as LSP_EMPTY_RESULTS,
  isStaleSentinel,
  type LspBackendExecutor,
  type LspOpCtx,
  type LspExecutorOp,
  type LspCallPayload,
  type DocOpenEvent,
  type DocChangeEvent,
  type DocCloseEvent,
} from './lsp/executor-types.js';
export {
  onDocEvent,
  allDocs,
  getDoc,
  openDoc,
  closeDoc,
  type StoredDoc,
  type DocListener,
} from './lsp/document-store.js';
export { createEditorHandlers } from './editor/index.js';
export { createSnapshotsHandlers } from './snapshots/index.js';
export { createSearchHandlers } from './search/index.js';
export { createProjectGitHandlers } from './projectGit/index.js';
export { disposeProjectGitProcesses } from './projectGit/index.js';
export { PROJECT_GIT_RPC_METHODS, type ProjectGitRpcMethod } from './projectGit/guard.js';
export { createPluginsHandlers } from './plugins/index.js';
export { createSystemHandlers } from './system/index.js';
export { generateAiPipeline, type GeneratePipelineResult } from './projectPipeline/generate.js';

/**
 * Aggregate factory. As more namespaces are extracted, add them here so
 * the Electron main process can mount the full `Api` in one call.
 *
 * Not yet wired (Dia 4+): admin, docs, designSystem, company, workspace.
 * Those serve features (multi-agent, doc RAG, design system) that are
 * Pro-tier features and don't block the core IDE loop. Their Hono routes
 * continue to work as legacy adapters.
 */
export function createHandlers(deps: HandlerDeps): Partial<Api> {
  return {
    projects: createProjectsHandlers(deps),
    files: createFilesHandlers(deps),
    terminal: createTerminalHandlers(deps),
    ssh: createSshHandlers(deps),
    dbClient: createDbClientHandlers(deps),
    runner: createRunnerHandlers(deps),
    debug: createDebugHandlers(deps),
    runtime: createRuntimeHandlers(deps),
    coder: createCoderHandlers(deps),
    lsp: createLspHandlers(deps),
    editor: createEditorHandlers(deps),
    snapshots: createSnapshotsHandlers(deps),
    search: createSearchHandlers(deps),
    projectGit: createProjectGitHandlers(deps),
    plugins: createPluginsHandlers(deps),
    system: createSystemHandlers(deps),
  };
}
