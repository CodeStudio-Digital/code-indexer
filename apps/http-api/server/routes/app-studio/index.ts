/**
 * App Studio routes ("Code Studio para leigos") — criação (scaffold SSE)
 * + sessões. Toda a superfície é gated por
 * `config.features.appStudioEnabled` (APP_STUDIO_ENABLED=false desliga).
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountAppStudioCreateRoutes } from './studio.js';
import { mountAppStudioSessionRoutes } from './sessions.js';
import { mountAppStudioDataRoutes } from './data.js';
import { mountAppStudioLaunchRoutes } from './launch.js';
import { mountAppStudioSpecRoutes } from './spec.js';
import { mountAppStudioRevisionRoutes } from './revisions.js';
import { mountAppStudioArchitectureRoutes } from './architecture.js';
import { mountAppStudioProductRoutes } from './product.js';
import { mountAppStudioWorkflowRoutes } from './workflow.js';
import { mountAppStudioAgentRoutes } from './agents.js';
import { requireLocalOrigin } from './origin-guard.js';

export function mountAppStudioRoutes(app: Hono, deps: ServerDeps): void {
  if (!deps.config.features.appStudioEnabled) return;
  // Guard de origem ANTES das rotas: /launch cria recursos CF e /data lê o
  // banco local — nenhum site remoto pode chamar (drive-by). Registrado
  // primeiro para envolver todos os handlers app-studio abaixo.
  app.use('/api/app-studio/*', requireLocalOrigin);
  mountAppStudioCreateRoutes(app, deps);
  mountAppStudioSessionRoutes(app, deps);
  mountAppStudioDataRoutes(app, deps);
  mountAppStudioLaunchRoutes(app, deps);
  mountAppStudioSpecRoutes(app, deps);
  mountAppStudioRevisionRoutes(app, deps);
  mountAppStudioArchitectureRoutes(app, deps);
  mountAppStudioProductRoutes(app, deps);
  mountAppStudioWorkflowRoutes(app, deps);
  mountAppStudioAgentRoutes(app, deps);
}
