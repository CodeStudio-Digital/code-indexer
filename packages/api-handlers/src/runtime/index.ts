/**
 * Handlers for the `runtime` namespace — Node.js version management.
 *
 * Detection + download live in ./detect-node.ts and ./node-manager.ts.
 * The terminal and runner handlers import `resolveProjectNodeBinDir` from
 * node-manager to put the project's chosen Node on PATH at spawn time.
 */

import { ensureDataDir } from '@mcp/shared/utils/config.js';
import type { RuntimeApi } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { detectNodeRuntimes } from './detect-node.js';
import { download, listAvailable, remove } from './node-manager.js';

export function createRuntimeHandlers(_deps: HandlerDeps): RuntimeApi {
  return {
    async listNode() {
      return detectNodeRuntimes(ensureDataDir());
    },

    async listAvailable() {
      return listAvailable();
    },

    download({ version }) {
      return download(version, ensureDataDir());
    },

    async remove({ version }) {
      await remove(version, ensureDataDir());
    },
  };
}
