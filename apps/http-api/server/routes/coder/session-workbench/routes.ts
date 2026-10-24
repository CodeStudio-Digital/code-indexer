import type { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import {
  parseSessionWorkbenchListQuery,
  parseSessionWorkbenchConfigurationQuery,
  parseSessionWorkbenchCommand,
  parseSessionWorkbenchCommandBatch,
  parseSessionWorkbenchContextQuery,
  parseSessionWorkbenchExecutionQuery,
  parseSessionWorkbenchEventQuery,
  parseSessionWorkbenchInsightsQuery,
  SessionWorkbenchResponseValidationError,
  validateSessionWorkbenchBootstrap,
  validateSessionWorkbenchCommandResult,
  validateSessionWorkbenchCommandResults,
  validateSessionWorkbenchConfigurationResource,
  validateSessionWorkbenchContextResource,
  validateSessionWorkbenchExecutionResource,
  validateSessionWorkbenchEventPage,
  validateSessionWorkbenchInsightsResource,
  validateSessionWorkbenchSessionPage,
  type SessionWorkbenchListRawQuery,
  type SessionWorkbenchEventRawQuery,
  type SessionWorkbenchResourceRawQuery,
} from '@mcp/api-bus';
import { FsSessionWorkbenchBootstrapProjectionReader } from '@mcp/session-storage/fs-store/session-workbench-bootstrap-projection.js';
import { FsSessionWorkbenchProjection } from '@mcp/session-storage/fs-store/session-workbench-projection.js';
import { getAllKnownToolsMeta } from '@mcp/code-agent/tools/tiers.js';
import type { ServerDeps } from '../../../deps.js';
import { getCoderWorkerPool } from '../../../../sse/coderWorkerPoolSingleton.js';
import {
  assertSupportedConversationFormat,
  isRetiredConversationFormatError,
} from '../../../../retired-conversation-format.js';
import {
  flushRuntimeEventLogWrites,
  listPersistedRuntimeEventPage,
} from '../../../../sse/runtime-event-log-storage.js';
import { createSessionWorkbenchPluginCapabilityResolver } from './plugin-capabilities.js';
import { SessionWorkbenchCommandService } from './command-service.js';
import { publishSessionWorkbenchEvent } from './event-hub.js';
import { SessionWorkbenchEventService } from './event-service.js';
import { SessionWorkbenchResourceService } from './resource-service.js';
import {
  SessionWorkbenchQueryError,
  SessionWorkbenchQueryService,
} from './query-service.js';

interface SessionWorkbenchListService {
  listSessions: SessionWorkbenchQueryService['listSessions'];
  bootstrap: SessionWorkbenchQueryService['bootstrap'];
}

const CANONICAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionIdParam(value: string): SessionId {
  if (!CANONICAL_SESSION_ID.test(value)) {
    throw new TypeError('id must be a canonical session UUID');
  }
  return asSessionId(value.toLowerCase());
}

interface MountSessionWorkbenchRoutesOptions {
  service?: SessionWorkbenchListService;
  resources?: Pick<
    SessionWorkbenchResourceService,
    'context' | 'execution' | 'insights' | 'configuration'
  >;
  events?: Pick<SessionWorkbenchEventService, 'list'>;
  commands?: Pick<SessionWorkbenchCommandService, 'execute' | 'batch'>;
}

function rawListQuery(query: (name: string) => string | undefined): SessionWorkbenchListRawQuery {
  return {
    scope: query('scope'),
    project_id: query('project_id'),
    cursor: query('cursor'),
    limit: query('limit'),
    query: query('query'),
    archived: query('archived'),
    favorite: query('favorite'),
    status: query('status'),
    provider: query('provider'),
    group_by: query('group_by'),
  };
}

function rawResourceQuery(query: (name: string) => string | undefined): SessionWorkbenchResourceRawQuery {
  return {
    view: query('view'),
    cursor: query('cursor'),
    limit: query('limit'),
  };
}

function rawEventQuery(query: (name: string) => string | undefined): SessionWorkbenchEventRawQuery {
  return {
    cursor: query('cursor'),
    limit: query('limit'),
    category: query('category'),
    level: query('level'),
    query: query('query'),
  };
}

export function mountSessionWorkbenchRoutes(
  app: Hono,
  deps: ServerDeps,
  options: MountSessionWorkbenchRoutesOptions = {},
): void {
  const workerPool = options.service ? null : getCoderWorkerPool();
  const resolveRuntimeState = async (sessionId: SessionId) => {
    const active = workerPool?.isRunning(sessionId) ?? false;
    if (!active) return { active: false, waitingForInput: false };
    try {
      return {
        active: true,
        waitingForInput: await workerPool!.isWaitingForInput(sessionId),
      };
    } catch {
      return { active: true, waitingForInput: null };
    }
  };
  const service = options.service ?? (() => {
    return new SessionWorkbenchQueryService(
      new FsSessionWorkbenchProjection(deps.sessionStore),
      (sessionId) => workerPool!.isRunning(sessionId),
      new FsSessionWorkbenchBootstrapProjectionReader(deps.sessionStore),
      createSessionWorkbenchPluginCapabilityResolver(deps),
      resolveRuntimeState,
    );
  })();
  let events = options.events;
  const eventService = () => events ??= new SessionWorkbenchEventService({
    listPage: async (sessionId, input) => {
      const location = await deps.sessionStore.getSessionLocation(sessionId);
      if (!location) {
        throw new SessionWorkbenchQueryError(
          'session_not_found',
          404,
          false,
          'session does not exist',
          { sessionId },
        );
      }
      await flushRuntimeEventLogWrites();
      return listPersistedRuntimeEventPage(
        'coder',
        sessionId,
        { bundlePath: location.bundle_path },
        { ...input, order: 'desc' },
      );
    },
  });
  let resources = options.resources;
  const resourceService = () => resources ??= new SessionWorkbenchResourceService(
    deps.sessionStore,
    deps.skillStore,
    getAllKnownToolsMeta,
    (projectId) => {
      const project = deps.db.getProject(projectId);
      return Boolean(project && !project.is_synthetic && project.root_path.trim().length > 0);
    },
    resolveRuntimeState,
    (sessionId, input) => eventService().list(sessionId, input),
  );
  let commands = options.commands;
  const commandService = () => commands ??= new SessionWorkbenchCommandService(
    deps.sessionStore,
    async (session) => {
      const explicit = session.state.tools.active_skills;
      if (Array.isArray(explicit)) {
        return new Set(explicit.filter((value): value is string => typeof value === 'string'));
      }
      const scopes = ['global', ...session.linked_projects.map((project) => String(project.project_id))];
      const active = new Set<string>();
      let offset = 0;
      while (true) {
        const page = deps.skillStore.listSkillSummaries({ scopes, offset, limit: 500, enabled: true });
        for (const skill of page.items) active.add(skill.id);
        if (page.nextOffset == null) break;
        offset = page.nextOffset;
      }
      return active;
    },
    publishSessionWorkbenchEvent,
  );

  app.get('/api/coder/session-workbench/sessions', async (c) => {
    try {
      const input = parseSessionWorkbenchListQuery(rawListQuery((name) => c.req.query(name)));
      const result = validateSessionWorkbenchSessionPage(await service.listSessions(input));
      const etag = `"csw-${result.queryRevision}"`;
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, no-cache');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      return c.json(result);
    } catch (error) {
      if (error instanceof SessionWorkbenchQueryError) {
        return c.json({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          context: error.context,
        }, error.status);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError) {
        return c.json({
          code: 'invalid_query',
          message: error.message,
          retryable: false,
          context: {},
        }, 400);
      }
      throw error;
    }
  });

  app.get('/api/coder/session-workbench/sessions/:id/bootstrap', async (c) => {
    try {
      const sessionId = sessionIdParam(c.req.param('id'));
      const result = validateSessionWorkbenchBootstrap(await service.bootstrap(sessionId));
      const etag = `"csw-${sessionId}-${result.revision}"`;
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, no-cache');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      return c.json(result);
    } catch (error) {
      if (error instanceof SessionWorkbenchQueryError) {
        return c.json({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          context: error.context,
        }, error.status);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError) {
        return c.json({
          code: 'invalid_session_id',
          message: error.message,
          retryable: false,
          context: {},
        }, 400);
      }
      throw error;
    }
  });

  app.get('/api/coder/session-workbench/sessions/:id/context', async (c) => {
    try {
      const sessionId = sessionIdParam(c.req.param('id'));
      const query = parseSessionWorkbenchContextQuery(rawResourceQuery((name) => c.req.query(name)));
      const result = validateSessionWorkbenchContextResource(await resourceService().context(sessionId, query));
      const etag = `"csw-${sessionId}-context-${result.view}-${result.revision}"`;
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, no-cache');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      return c.json(result);
    } catch (error) {
      if (error instanceof SessionWorkbenchQueryError) {
        return c.json({ code: error.code, message: error.message, retryable: error.retryable, context: error.context }, error.status);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError) {
        return c.json({ code: 'invalid_query', message: error.message, retryable: false, context: {} }, 400);
      }
      throw error;
    }
  });

  app.get('/api/coder/session-workbench/sessions/:id/execution', async (c) => {
    try {
      const sessionId = sessionIdParam(c.req.param('id'));
      const query = parseSessionWorkbenchExecutionQuery(rawResourceQuery((name) => c.req.query(name)));
      const result = validateSessionWorkbenchExecutionResource(await resourceService().execution(sessionId, query));
      const etag = `"csw-${sessionId}-execution-${result.view}-${result.revision}"`;
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, no-cache');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      return c.json(result);
    } catch (error) {
      if (error instanceof SessionWorkbenchQueryError) {
        return c.json({ code: error.code, message: error.message, retryable: error.retryable, context: error.context }, error.status);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError) {
        return c.json({ code: 'invalid_query', message: error.message, retryable: false, context: {} }, 400);
      }
      throw error;
    }
  });

  app.get('/api/coder/session-workbench/sessions/:id/insights', async (c) => {
    try {
      const sessionId = sessionIdParam(c.req.param('id'));
      const query = parseSessionWorkbenchInsightsQuery(rawResourceQuery((name) => c.req.query(name)));
      const result = validateSessionWorkbenchInsightsResource(await resourceService().insights(sessionId, query));
      const etag = `"csw-${sessionId}-insights-${result.view}-${result.revision}"`;
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, no-cache');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      return c.json(result);
    } catch (error) {
      if (error instanceof SessionWorkbenchQueryError) {
        return c.json({ code: error.code, message: error.message, retryable: error.retryable, context: error.context }, error.status);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError) {
        return c.json({ code: 'invalid_query', message: error.message, retryable: false, context: {} }, 400);
      }
      throw error;
    }
  });

  app.get('/api/coder/session-workbench/sessions/:id/configuration', async (c) => {
    try {
      const sessionId = sessionIdParam(c.req.param('id'));
      const query = parseSessionWorkbenchConfigurationQuery(rawResourceQuery((name) => c.req.query(name)));
      const result = validateSessionWorkbenchConfigurationResource(await resourceService().configuration(sessionId, query));
      const etag = `"csw-${sessionId}-configuration-${result.view}-${result.revision}"`;
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, no-cache');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      return c.json(result);
    } catch (error) {
      if (error instanceof SessionWorkbenchQueryError) {
        return c.json({ code: error.code, message: error.message, retryable: error.retryable, context: error.context }, error.status);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError) {
        return c.json({ code: 'invalid_query', message: error.message, retryable: false, context: {} }, 400);
      }
      throw error;
    }
  });

  app.get('/api/coder/session-workbench/sessions/:id/events', async (c) => {
    try {
      const sessionId = sessionIdParam(c.req.param('id'));
      const query = parseSessionWorkbenchEventQuery(rawEventQuery((name) => c.req.query(name)));
      const result = validateSessionWorkbenchEventPage(await eventService().list(sessionId, query));
      const etag = `"csw-${sessionId}-events-${result.revision}"`;
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, no-cache');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      return c.json(result);
    } catch (error) {
      if (error instanceof SessionWorkbenchQueryError) {
        return c.json({ code: error.code, message: error.message, retryable: error.retryable, context: error.context }, error.status);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError) {
        return c.json({ code: 'invalid_query', message: error.message, retryable: false, context: {} }, 400);
      }
      throw error;
    }
  });

  app.post('/api/coder/session-workbench/commands', async (c) => {
    try {
      const command = parseSessionWorkbenchCommand(await c.req.json<unknown>());
      if (command.type === 'duplicate') {
        await assertSupportedConversationFormat(deps.config.dbPath, command.sessionId);
      }
      return c.json(validateSessionWorkbenchCommandResult(await commandService().execute(command)));
    } catch (error) {
      if (isRetiredConversationFormatError(error)) {
        return c.json({ code: error.code, message: error.message, retryable: false, context: {} }, 409);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError || error instanceof SyntaxError) {
        return c.json({ code: 'invalid_command', message: error.message, retryable: false, context: {} }, 400);
      }
      throw error;
    }
  });

  app.post('/api/coder/session-workbench/commands/batch', async (c) => {
    try {
      const commands = parseSessionWorkbenchCommandBatch(await c.req.json<unknown>());
      // Preflight the whole batch before any command can mutate a conversation.
      for (const command of commands) {
        if (command.type === 'duplicate') {
          await assertSupportedConversationFormat(deps.config.dbPath, command.sessionId);
        }
      }
      return c.json(validateSessionWorkbenchCommandResults(await commandService().batch(commands)));
    } catch (error) {
      if (isRetiredConversationFormatError(error)) {
        return c.json({ code: error.code, message: error.message, retryable: false, context: {} }, 409);
      }
      if (error instanceof SessionWorkbenchResponseValidationError) {
        return c.json({ code: 'invalid_response', message: error.message, retryable: true, context: { path: error.path } }, 500);
      }
      if (error instanceof TypeError || error instanceof SyntaxError) {
        return c.json({ code: 'invalid_command_batch', message: error.message, retryable: false, context: {} }, 400);
      }
      throw error;
    }
  });
}
