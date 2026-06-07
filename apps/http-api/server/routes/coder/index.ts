import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { createCoderRuntime } from './state.js';
import { mountCoderProvidersRoutes } from './providers.js';
import { mountCoderSessionsRoutes } from './sessions.js';
import { mountCoderGroupsRoutes } from './groups.js';
import { mountCoderInteractionRoutes } from './interaction.js';
import { mountCoderSpecResponseRoute } from './spec-response.js';
import { mountCoderStreamRoutes } from './stream.js';
import { mountCoderSkillsRoutes } from './skills.js';
import { mountCoderProjectTreeRoutes } from './project-tree.routes.js';
import { mountCoderPipelineRoutes } from './pipelines.js';
import { mountCoderSnapshotRoutes } from './snapshot.js';
import { mountCoderDriveRoutes } from './drive.js';
import { mountCoderSummarizeClearRoute } from './summarize-clear.js';
import { mountCompanyRoutes } from '../company/index.js';

export function mountCoderRoutes(app: Hono, deps: ServerDeps): void {
  const runtime = createCoderRuntime(deps.sessionStore);
  mountCoderProvidersRoutes(app, deps);
  mountCoderSessionsRoutes(app, deps, runtime);
  mountCoderGroupsRoutes(app, deps);
  mountCoderInteractionRoutes(app, deps, runtime);
  mountCoderSpecResponseRoute(app, deps, runtime);
  mountCoderStreamRoutes(app, deps, runtime);
  mountCoderSkillsRoutes(app, deps, runtime);
  mountCoderProjectTreeRoutes(app, deps);
  mountCoderPipelineRoutes(app, deps, runtime);
  mountCoderSnapshotRoutes(app, deps);
  mountCoderDriveRoutes(app, deps);
  mountCoderSummarizeClearRoute(app, deps, runtime);
  mountCompanyRoutes(app, deps);
}
