import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { mountCompanyTemplateRoutes } from './templates.js';
import { mountCompanySessionRoutes } from './sessions.js';
import { mountCompanyChildRoutes } from './children.js';
import { mountCompanyStreamRoutes } from './stream.js';
import { mountCompanyBoardRoutes } from './board.js';
import { mountCompanyKanbanRoutes } from './kanban.js';
import { mountCompanyArchiveRoutes } from './archives.js';
import { mountCompanyDatabaseRoutes } from './databases.js';
import { mountCompanyLocalProjectRoutes } from './local-project.js';
import { mountCompanyPipelineRoutes } from './pipelines.js';
import { mountCompanyInboxRoutes } from './inbox.js';
import { mountCompanyDriveRoutes } from './drive.js';
import { mountCompanySnapshotRoutes } from './snapshot.js';
import { mountCompanyDocsRoutes } from './docs.js';
import { mountCompanyEnvsRoutes } from './envs.js';
import { mountCompanyOpenApiRoutes } from './openapi.js';
import { mountCompanySessionDeleteRoutes } from './session-delete.js';
import { mountCompanyServiceLifecycleRoutes } from './service-lifecycle.js';
import { mountCompanySandboxRoutes } from './sandbox.js';
import { mountCompanyServicesRoutes } from './services.js';
import { mountQaRoutes } from './qa/index.js';

export function mountCompanyRoutes(app: Hono, deps: ServerDeps): void {
  mountCompanyTemplateRoutes(app, deps);
  mountCompanySessionRoutes(app, deps);
  mountCompanyChildRoutes(app, deps);
  mountCompanyStreamRoutes(app, deps);
  mountCompanyBoardRoutes(app, deps);
  mountCompanyKanbanRoutes(app, deps);
  mountCompanyArchiveRoutes(app, deps);
  mountCompanyDatabaseRoutes(app, deps);
  mountCompanyLocalProjectRoutes(app, deps);
  mountCompanyPipelineRoutes(app, deps);
  mountCompanyInboxRoutes(app, deps);
  mountCompanyDriveRoutes(app, deps);
  mountCompanySnapshotRoutes(app, deps);
  // Phase 8: route groups split out of the legacy sessions.ts mega-file.
  mountCompanyDocsRoutes(app, deps);
  mountCompanyEnvsRoutes(app, deps);
  mountCompanyOpenApiRoutes(app, deps);
  mountCompanySessionDeleteRoutes(app, deps);
  mountCompanyServiceLifecycleRoutes(app, deps);
  // Phase 8 part 2 (continuation): sandbox + services CRUD finally out of sessions.ts.
  mountCompanySandboxRoutes(app, deps);
  mountCompanyServicesRoutes(app, deps);
  mountQaRoutes(app, deps);
}
