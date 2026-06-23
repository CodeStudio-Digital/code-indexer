/**
 * Adapt the live runner handlers + shared PTY manager into the lean
 * `RunnerBridge` the preview dev-server resolver consumes. Built in main.ts
 * from the SAME handlers instance mounted over IPC, so `list()` sees the
 * dashboard's running dev servers (a fresh `createRunnerHandlers` would have
 * its own empty registry).
 */
import { createContext, sharedPtyManager } from '@mcp/api-handlers';
import type { RunnerApi, RunnerManager } from '@mcp/api-bus';
import type { ServerDeps } from '@apps/http-api/server/deps.js';
import { pickDevRunner, type RunnerBridge } from './dev-server-resolver.js';

function parsePinnedPort(builderJson: string | null | undefined): number | null {
  if (!builderJson) return null;
  try {
    const cfg = JSON.parse(builderJson) as { port?: unknown };
    return typeof cfg.port === 'number' && cfg.port > 0 ? cfg.port : null;
  } catch {
    return null;
  }
}

export function buildRunnerBridge(runner: RunnerApi, deps: ServerDeps): RunnerBridge {
  // RunnerTask is a superset of ResolverRunnerTask, so the lists/tasks are
  // structurally assignable — no shaping needed.
  return {
    list: () => runner.list({}, createContext()),
    start: (input) =>
      runner.start({ ...input, manager: input.manager as RunnerManager }, createContext()),
    stop: (taskId) => runner.stop({ taskId }, createContext()),
    detectDevCommand: async (projectId) => {
      const detected = await runner.detect({ projectId }, createContext());
      return pickDevRunner(detected.groups);
    },
    readBuffer: (terminalId) => {
      try {
        return sharedPtyManager.get(terminalId).buffer;
      } catch {
        return [];
      }
    },
    pinnedPort: (projectId) => parsePinnedPort(deps.db.getProject(projectId)?.builder_json),
  };
}
