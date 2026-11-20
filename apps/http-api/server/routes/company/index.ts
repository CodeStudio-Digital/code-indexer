import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { mountCompanyTemplateRoutes } from './templates.js';
import { mountCompanyFileSessionRoutes } from './session-files.routes.js';
import { mountCompanySessionDeleteRoutes } from './session-delete.js';
import { mountCompanyChildRoutes } from './children.js';
import { mountCompanyStreamRoutes } from './stream.js';
import { mountCompanyAgentControlRoutes } from './agents.js';
import { mountCompanyBoardRoutes } from './board.js';
import { mountCompanyKanbanRoutes } from './kanban.js';
import { mountCompanyKanbanDispatchRoutes } from './kanban-dispatch.js';
import { mountCompanyArchiveRoutes } from './archives.js';
import { mountCompanyDbConnectionsRoutes } from './db-connections.js';
import { mountCompanyLocalProjectRoutes } from './local-project.js';
import { mountCompanyInboxRoutes } from './inbox.js';
import { mountCompanyDriveRoutes } from './drive.js';
import { mountCompanySnapshotRoutes } from './snapshot.js';
import { mountCompanyDocsRoutes } from './docs.js';
import { mountCompanyDocsRagRoutes } from './docs-rag.js';
import { mountCompanyEnvsRoutes } from './envs.js';
import { mountCompanyOpenApiRoutes } from './openapi.js';
import { mountCompanyServiceLifecycleRoutes } from './service-lifecycle.js';
import { mountCompanyServiceLogsRoutes } from './service-logs.js';
import { mountCompanySandboxRoutes } from './sandbox.js';
import { mountCompanyServicesRoutes } from './services.js';
import { mountQaRoutes } from './qa/index.js';
import { mountCompanyRecommendationsRoutes } from './recommendations.js';
import { mountReestablishMasterRoute } from './reestablish-master.js';
import { mountCompanyAutonomyRoutes } from './autonomy.js';

export function mountCompanyRoutes(app: HttpRouter, deps: ServerDeps): void {
  mountCompanyTemplateRoutes(app, deps);
  mountCompanyFileSessionRoutes(app, deps, { includeDelete: false });
  mountCompanySessionDeleteRoutes(app, deps);
  mountCompanyChildRoutes(app, deps);
  mountCompanyStreamRoutes(app, deps);
  mountCompanyAgentControlRoutes(app, deps);
  mountCompanyBoardRoutes(app, deps);
  mountCompanyKanbanRoutes(app, deps);
  // C3 — proactive kanban: manual card dispatch + role suggestions.
  mountCompanyKanbanDispatchRoutes(app, deps);
  mountCompanyArchiveRoutes(app, deps);
  // Read-only projection of the linked projects' Databases-tab connections
  // (the session-scoped database CRUD was retired — migration 191).
  mountCompanyDbConnectionsRoutes(app, deps);
  mountCompanyLocalProjectRoutes(app, deps);
  mountCompanyInboxRoutes(app, deps);
  mountCompanyDriveRoutes(app, deps);
  mountCompanySnapshotRoutes(app, deps);
  // Phase 8: route groups split out of the legacy sessions.ts mega-file.
  mountCompanyDocsRoutes(app, deps);
  // D2 — docs → RAG bridge (index a doc into the project-linked corpus).
  mountCompanyDocsRagRoutes(app, deps);
  mountCompanyEnvsRoutes(app, deps);
  mountCompanyOpenApiRoutes(app, deps);
  mountCompanyServiceLifecycleRoutes(app, deps);
  // B4 — structured log history + transitions timeline (read-only, mig 188).
  mountCompanyServiceLogsRoutes(app, deps);
  // Phase 8 part 2 (continuation): sandbox + services CRUD finally out of sessions.ts.
  mountCompanySandboxRoutes(app, deps);
  mountCompanyServicesRoutes(app, deps);
  mountQaRoutes(app, deps);
  // Pipeline-backed recommendations (RolePipeline + KanbanPriorityPipeline).
  mountCompanyRecommendationsRoutes(app, deps);
  // Phase H — on-demand recovery agent (audits kanban + state, repairs).
  mountReestablishMasterRoute(app, deps);
  // C1 — organism visibility: effective autonomy config + persisted
  // incidents + durable [AUTO] posts for the dashboard AutonomyPanel.
  mountCompanyAutonomyRoutes(app, deps);
}
