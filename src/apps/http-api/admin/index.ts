/**
 * Admin HTTP router — composition root for /api/admin/*.
 *
 * Mounted by src/apps/http-api/server.ts. Each concern lives in a sibling
 * file and exports its own Hono sub-router; this file just wires them
 * together in declaration order.
 *
 * Routes do NOT enforce authentication today — the dashboard runs locally
 * on http://localhost:3333 per project convention. If that ever changes,
 * add a middleware here (`app.use('*', ...)`).
 */
import { Hono } from 'hono';
import type { ProviderStore } from '../../../store/provider-store.js';
import { providersRouter } from './providers.routes.js';
import { modelsRouter } from './models.routes.js';
import { embeddingsRouter } from './embeddings.routes.js';
import { vectorStoresRouter } from './vector-stores.routes.js';
import { oauthRouter } from './oauth.routes.js';
import { copilotOAuthRouter } from './oauth-copilot.routes.js';
import { openaiOAuthRouter } from './oauth-openai.routes.js';
import { claudeCodeOAuthRouter } from './oauth-claude-code.routes.js';
import { bedrockOAuthRouter } from './oauth-bedrock.routes.js';
import { googleOAuthRouter } from './oauth-google.routes.js';
import { kimiCodeOAuthRouter } from './oauth-kimi-code.routes.js';
import { toolsRouter } from './tools.routes.js';
import { mcpServersRouter } from './mcp-servers.routes.js';
import { skillsRouter } from './skills.routes.js';
import { generalAiRouter } from './general-ai.routes.js';
import { chromeServiceRouter } from './chrome-service.routes.js';
import { verdaccioRouter } from './verdaccio.routes.js';
import { bedrockModelAccessRouter } from './bedrock-model-access.routes.js';

export function createAdminRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.route('/', providersRouter(store));
  app.route('/', modelsRouter(store));
  app.route('/', embeddingsRouter(store));
  app.route('/', vectorStoresRouter(store));
  app.route('/', oauthRouter(store));
  app.route('/', copilotOAuthRouter(store));
  app.route('/', openaiOAuthRouter(store));
  app.route('/', claudeCodeOAuthRouter(store));
  app.route('/', bedrockOAuthRouter(store));
  app.route('/', bedrockModelAccessRouter(store));
  app.route('/', googleOAuthRouter(store));
  app.route('/', kimiCodeOAuthRouter(store));
  app.route('/', toolsRouter(store));
  app.route('/', mcpServersRouter());
  app.route('/', skillsRouter());
  app.route('/', generalAiRouter(store));
  app.route('/', chromeServiceRouter());
  app.route('/', verdaccioRouter());

  return app;
}
