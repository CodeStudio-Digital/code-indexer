/**
 * The per-kind detection switch, shared by the main thread and the detection
 * worker.
 *
 * Every detector here is synchronous by construction: they shell out with
 * `execFileSync`/`spawnSync` (2.5s timeout each) and walk directories with
 * `readdirSync`. That is fine inside a worker and unacceptable on the Electron
 * main thread, where `api:runner:detect` was measured at avg 828ms / max 11.2s
 * — every millisecond of which also froze the window, the terminals and all
 * other IPC. See detect-runner.ts for the off-thread wrapper.
 *
 * Keep this module free of `deps`/db/LSP imports: it is loaded inside a worker,
 * where module-level singletons from the main thread do not exist.
 */

import { ApiError } from '@mcp/api-bus';
import type { Runtime, RuntimeKind } from '@mcp/api-bus';
import { detectNodeRuntimes } from './detect-node.js';
import { detectJavaRuntimes } from './detect-java.js';
import { detectDotnetRuntimes } from './detect-dotnet.js';
import * as phpManager from './php-manager.js';
import * as pythonManager from './python-manager.js';

/** Detect installed runtimes of one kind. Synchronous and CPU/IO bound. */
export function listFor(kind: RuntimeKind, dataDir: string): Runtime[] {
  if (kind === 'node') return detectNodeRuntimes(dataDir);
  if (kind === 'php') return phpManager.detect(dataDir);
  if (kind === 'python') return pythonManager.detect(dataDir);
  if (kind === 'java') return detectJavaRuntimes(dataDir);
  if (kind === 'dotnet') return detectDotnetRuntimes(dataDir);
  throw new ApiError('unsupported', 400, `unknown runtime kind: ${kind}`);
}
