/**
 * Admin HTTP router — composition root for /api/admin/*.
 *
 * Mounted by src/apps/http-api/server.ts. Each concern lives in a sibling
 * file and exports its own Hono sub-router; this file just wires them
 * together in declaration order.
 *
 * Routes do NOT enforce authentication today — the dashboard runs locally
 * on http://localhost:7333 per project convention. If that ever changes,
 * add a middleware here (`app.use('*', ...)`).
 */
import { Hono } from 'hono';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { providersRouter } from './providers.routes.js';
import { modelsRouter } from './models.routes.js';
import { semanticRouter, type SemanticAdminRuntime } from './semantic.routes.js';
import { oauthRouter } from './oauth.routes.js';
import { copilotOAuthRouter } from './oauth-copilot.routes.js';
import { openaiOAuthRouter } from './oauth-openai.routes.js';
import { claudeCodeOAuthRouter } from './oauth-claude-code.routes.js';
import { bedrockOAuthRouter } from './oauth-bedrock.routes.js';
import { googleOAuthRouter } from './oauth-google.routes.js';
import { toolsRouter } from './tools.routes.js';
import { mcpServersRouter, type McpAdminRuntime } from './mcp-servers.routes.js';
import { skillsRouter } from './skills.routes.js';
import { generalAiRouter } from './general-ai.routes.js';
import { chromeServiceRouter } from './chrome-service.routes.js';
import { bedrockModelAccessRouter } from './bedrock-model-access.routes.js';
import { capabilitiesRouter } from './capabilities.routes.js';
import { customAgentsRouter } from './custom-agents.routes.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';

export function createAdminRouter(
  store: ProviderStore,
  semantic: SemanticAdminRuntime,
  sessionStore: FsSessionStore,
  mcpRuntime: McpAdminRuntime = {},
): Hono {
  const app = new Hono();

  app.route('/', providersRouter(store));
  app.route('/', modelsRouter(store));
  app.route('/', semanticRouter(store, semantic));
  app.route('/', oauthRouter(store));
  app.route('/', copilotOAuthRouter(store));
  app.route('/', openaiOAuthRouter(store));
  app.route('/', claudeCodeOAuthRouter(store));
  app.route('/', bedrockOAuthRouter(store));
  app.route('/', bedrockModelAccessRouter(store));
  app.route('/', googleOAuthRouter(store));
  app.route('/', toolsRouter(store));
  app.route('/', mcpServersRouter(mcpRuntime));
  app.route('/', skillsRouter(sessionStore));
  app.route('/', generalAiRouter(store));
  app.route('/', chromeServiceRouter());
  app.route('/', capabilitiesRouter());
  app.route('/', customAgentsRouter(store));

  return app;
}
