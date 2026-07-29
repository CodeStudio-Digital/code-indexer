/**
 * Pick the backend host. One line today; the branch is the point.
 *
 * `MCP_BACKEND_PROCESS=1` is reserved for the `utilityProcess` host and throws
 * until that lands — a loud failure beats silently booting in-process and
 * making an operator think they were testing the new path.
 */

import { type BackendHandle, backendProcessMode } from './handle.js';
import { createInProcessBackend } from './in-process.js';

export function createBackend(): BackendHandle {
  const mode = backendProcessMode();
  if (mode === 'utility') {
    throw new Error(
      'MCP_BACKEND_PROCESS=1 requested the utilityProcess backend host, which is not implemented yet. ' +
      'Unset it (or set 0) to boot in-process.',
    );
  }
  return createInProcessBackend();
}
