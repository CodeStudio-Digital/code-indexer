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
import { createCoderHandlers } from './coder/index.js';
import type { HandlerDeps } from './types.js';

export type { HandlerDeps } from './types.js';
export { createContext, createInternalContext } from './context.js';
export { createProjectsHandlers } from './projects/index.js';
export { createFilesHandlers } from './files/index.js';
export { createTerminalHandlers } from './terminal/index.js';
export { createCoderHandlers } from './coder/index.js';

/**
 * Aggregate factory. As more namespaces are extracted, add them here so
 * the Electron main process can mount the full `Api` in one call.
 */
export function createHandlers(deps: HandlerDeps): Partial<Api> {
  return {
    projects: createProjectsHandlers(deps),
    files: createFilesHandlers(deps),
    terminal: createTerminalHandlers(deps),
    coder: createCoderHandlers(deps),
  };
}
