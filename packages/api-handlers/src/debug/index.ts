import { ApiError, type DebugApi } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { DebugSessionManager } from './session-manager.js';

const liveManagers = new Set<DebugSessionManager>();

export function createDebugHandlers(deps: HandlerDeps): DebugApi {
  const manager = new DebugSessionManager();
  liveManagers.add(manager);

  const project = (projectId: number) => {
    const value = deps.db.getProject(projectId);
    if (!value) throw new ApiError('not_found', 404, 'project not found');
    return value;
  };

  return {
    async adapters() {
      return manager.adapters();
    },
    async start(input) {
      const selected = project(input.projectId);
      try {
        return await manager.start(input.projectId, selected.root_path, input);
      } catch (error) {
        throw new ApiError('internal', 500, error instanceof Error ? error.message : String(error));
      }
    },
    async list() {
      return manager.list();
    },
    events() {
      return manager.events();
    },
    async stop({ sessionId }) {
      await manager.stop(sessionId);
    },
    async pause({ sessionId, threadId }) {
      await manager.control(sessionId, 'pause', threadId);
    },
    async continue({ sessionId, threadId }) {
      await manager.control(sessionId, 'continue', threadId);
    },
    async next({ sessionId, threadId }) {
      await manager.control(sessionId, 'next', threadId);
    },
    async stepIn({ sessionId, threadId }) {
      await manager.control(sessionId, 'stepIn', threadId);
    },
    async stepOut({ sessionId, threadId }) {
      await manager.control(sessionId, 'stepOut', threadId);
    },
    async setBreakpoints({ sessionId, source }) {
      const session = manager.list().find((item) => item.sessionId === sessionId);
      if (!session) throw new ApiError('not_found', 404, 'debug session not found');
      return manager.setBreakpoints(sessionId, project(session.projectId).root_path, source);
    },
    async threads({ sessionId }) {
      return manager.threads(sessionId);
    },
    async stackTrace({ sessionId, threadId, startFrame, levels }) {
      return manager.stackTrace(sessionId, threadId, startFrame, levels);
    },
    async scopes({ sessionId, frameId }) {
      return manager.scopes(sessionId, frameId);
    },
    async variables({ sessionId, variablesReference, start, count }) {
      return manager.variables(sessionId, variablesReference, start, count);
    },
    async evaluate({ sessionId, expression, frameId, context }) {
      return manager.evaluate(sessionId, expression, frameId, context);
    },
  };
}

export async function disposeDebugSessions(): Promise<void> {
  const managers = [...liveManagers];
  liveManagers.clear();
  await Promise.allSettled(managers.map((manager) => manager.dispose()));
}

export { DebugSessionManager } from './session-manager.js';
export { DapConnection, connectDapTcp } from './dap-connection.js';
