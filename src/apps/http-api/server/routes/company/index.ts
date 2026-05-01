import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountCompanyTemplateRoutes } from './templates.js';
import { mountCompanySessionRoutes } from './sessions.js';
import { mountCompanyStreamRoutes } from './stream.js';
import { mountCompanyBoardRoutes } from './board.js';
import { mountCompanyKanbanRoutes } from './kanban.js';
import { mountCompanyArchiveRoutes } from './archives.js';
import { mountCompanyDatabaseRoutes } from './databases.js';
import { mountCompanyLocalProjectRoutes } from './local-project.js';
import { mountCompanyPipelineRoutes } from './pipelines.js';
import { mountCompanyInboxRoutes } from './inbox.js';
import { mountQaRoutes } from './qa/index.js';

export function mountCompanyRoutes(app: Hono, deps: ServerDeps): void {
  mountCompanyTemplateRoutes(app, deps);
  mountCompanySessionRoutes(app, deps);
  mountCompanyStreamRoutes(app, deps);
  mountCompanyBoardRoutes(app, deps);
  mountCompanyKanbanRoutes(app, deps);
  mountCompanyArchiveRoutes(app, deps);
  mountCompanyDatabaseRoutes(app, deps);
  mountCompanyLocalProjectRoutes(app, deps);
  mountCompanyPipelineRoutes(app, deps);
  mountCompanyInboxRoutes(app, deps);
  mountQaRoutes(app, deps);
}
