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
import { createRunnerHandlers } from './runner/index.js';
import { createRuntimeHandlers } from './runtime/index.js';
import { createCoderHandlers } from './coder/index.js';
import { createLspHandlers } from './lsp/index.js';
import { createSnapshotsHandlers } from './snapshots/index.js';
import { createRunsHandlers } from './runs/index.js';
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
export { reinstrumentBuilder, type ReinstrumentResult } from './projects/reinstrument.js';
export {
  linkDesignSystem,
  unlinkDesignSystem,
  linkDsToDir,
  type DsConsumerLink,
} from './projects/link-design-system.js';
export { createFilesHandlers } from './files/index.js';
export { createTerminalHandlers } from './terminal/index.js';
export { createRunnerHandlers } from './runner/index.js';
export { createRuntimeHandlers } from './runtime/index.js';
export { createCoderHandlers } from './coder/index.js';
export { createLspHandlers } from './lsp/index.js';
export { createSnapshotsHandlers } from './snapshots/index.js';
export { createRunsHandlers } from './runs/index.js';
export { createSearchHandlers } from './search/index.js';
export { createProjectGitHandlers } from './projectGit/index.js';
export { createPluginsHandlers } from './plugins/index.js';
export { createSystemHandlers } from './system/index.js';
export { createTrainingHandlers, MCP_BLOCK_SERVER_KEY } from './training/index.js';
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
    runner: createRunnerHandlers(deps),
    runtime: createRuntimeHandlers(deps),
    coder: createCoderHandlers(deps),
    lsp: createLspHandlers(deps),
    snapshots: createSnapshotsHandlers(deps),
    runs: createRunsHandlers(deps),
    search: createSearchHandlers(deps),
    projectGit: createProjectGitHandlers(deps),
    plugins: createPluginsHandlers(deps),
    system: createSystemHandlers(deps),
  };
}
