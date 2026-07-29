/**
 * Minimal shared Company catalog.
 *
 * SQLite is allowed here only for reusable templates and reusable pipeline
 * definitions. Company/App Studio session state, agent runs, board, inbox,
 * kanban, archives and pipeline executions are filesystem entities owned by
 * their session bundle.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  CompanyRoleConfig,
  CompanyTemplate,
  Pipeline,
  PipelineExecution,
  PipelineNodeExecution,
} from '@mcp/company/types.js';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import { isUuid } from '@mcp/session-storage';
import * as templatesDomain from './company/templates.js';
import * as pipelines from './company/pipelines.js';
import * as pipelineDefinitions from './company/pipeline-definitions.js';
import * as pipelineExecutions from './company/pipeline-executions.js';
import * as pipelineNodeExecutions from './company/pipeline-node-executions.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class CompanyStore {
  private readonly db: DB;
  private readonly ownsHandle: boolean;
  private readonly sessionStore: FsSessionStore | null;

  constructor(
    dbPathOrHandle: string | DB,
    sessionStore?: FsSessionStore,
  ) {
    this.sessionStore = sessionStore ?? null;
    if (typeof dbPathOrHandle === 'string') {
      this.db = new Database(dbPathOrHandle);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsHandle = true;
    } else {
      this.db = dbPathOrHandle;
      this.ownsHandle = false;
    }
  }

  close(): void {
    if (this.ownsHandle) this.db.close();
  }

  private operationalSessions(): FsSessionStore {
    if (!this.sessionStore) {
      throw new Error(
        'Filesystem session store is required for session-owned pipeline state',
      );
    }
    return this.sessionStore;
  }

  // ─── Reusable Company templates (essential SQLite catalog) ─────
  createTemplate(
    name: string,
    description: string,
    roles: CompanyRoleConfig[],
  ): CompanyTemplate {
    return templatesDomain.createTemplate(this.db, name, description, roles);
  }

  getTemplate(id: number): CompanyTemplate | null {
    return templatesDomain.getTemplate(this.db, id);
  }

  listTemplates(): CompanyTemplate[] {
    return templatesDomain.listTemplates(this.db);
  }

  updateTemplate(
    id: number,
    patch: {
      name?: string;
      description?: string;
      roles?: CompanyRoleConfig[];
    },
  ): CompanyTemplate | null {
    return templatesDomain.updateTemplate(this.db, id, patch);
  }

  deleteTemplate(id: number): boolean {
    return templatesDomain.deleteTemplate(this.db, id);
  }

  // ─── Pipeline definitions ──────────────────────────────────────
  // Numeric definitions are reusable SQLite catalog rows. UUID definitions
  // and every execution/node record are bundle-local filesystem entities.
  async createPipeline(
    input: pipelines.CreatePipelineInput,
  ): Promise<Pipeline> {
    if (input.companySessionId != null) {
      return pipelineDefinitions.create(this.operationalSessions(), {
        name: input.name,
        description: input.description,
        graph: input.graph,
        companySessionId: input.companySessionId,
        templateId: input.templateId,
      });
    }
    return pipelines.create(this.db, input);
  }

  async getPipeline(id: number | string): Promise<Pipeline | null> {
    if (typeof id === 'number') return pipelines.get(this.db, id);
    if (!isUuid(id)) {
      throw new TypeError('pipeline id must be an integer or UUID');
    }
    return pipelineDefinitions.get(this.operationalSessions(), id);
  }

  async listPipelines(
    opts?: pipelines.ListPipelinesOptions & {
      companySessionId?: string | null;
    },
  ): Promise<Pipeline[]> {
    const reusable = pipelines.list(this.db, {
      projectId: opts?.projectId,
      templateId: opts?.templateId,
    });
    if (typeof opts?.companySessionId !== 'string') return reusable;
    const sessionOwned = await pipelineDefinitions.list(
      this.operationalSessions(),
      {
        companySessionId: opts.companySessionId,
        templateId: opts.templateId,
      },
    );
    return [...sessionOwned, ...reusable];
  }

  async updatePipeline(
    id: number | string,
    patch: Parameters<typeof pipelines.update>[2],
    opts?: { expectedVersion?: number },
  ): Promise<Pipeline | null> {
    if (typeof id === 'number') {
      return pipelines.update(this.db, id, patch, opts);
    }
    if (!isUuid(id)) {
      throw new TypeError('pipeline id must be an integer or UUID');
    }
    return pipelineDefinitions.update(
      this.operationalSessions(),
      id,
      patch,
      opts,
    );
  }

  async deletePipeline(id: number | string): Promise<boolean> {
    if (typeof id === 'number') return pipelines.del(this.db, id);
    if (!isUuid(id)) {
      throw new TypeError('pipeline id must be an integer or UUID');
    }
    return pipelineDefinitions.del(this.operationalSessions(), id);
  }

  createPipelineExecution(
    input: pipelineExecutions.CreateExecutionInput,
  ): Promise<PipelineExecution> {
    return pipelineExecutions.create(this.operationalSessions(), input);
  }

  getPipelineExecution(id: string): Promise<PipelineExecution | null> {
    return pipelineExecutions.get(this.operationalSessions(), id);
  }

  listPipelineExecutions(
    opts: pipelineExecutions.ListExecutionsOptions,
  ): Promise<PipelineExecution[]> {
    return pipelineExecutions.list(this.operationalSessions(), opts);
  }

  updatePipelineExecution(
    id: string,
    patch: pipelineExecutions.UpdateExecutionPatch,
  ): Promise<PipelineExecution | null> {
    return pipelineExecutions.update(this.operationalSessions(), id, patch);
  }

  createPipelineNodeExecution(
    input: pipelineNodeExecutions.CreateNodeExecutionInput,
  ): Promise<PipelineNodeExecution> {
    return pipelineNodeExecutions.create(this.operationalSessions(), input);
  }

  getPipelineNodeExecution(
    id: string,
  ): Promise<PipelineNodeExecution | null> {
    return pipelineNodeExecutions.get(this.operationalSessions(), id);
  }

  listPipelineNodeExecutions(
    executionId: string,
  ): Promise<PipelineNodeExecution[]> {
    return pipelineNodeExecutions.list(
      this.operationalSessions(),
      executionId,
    );
  }

  updatePipelineNodeExecution(
    id: string,
    patch: pipelineNodeExecutions.UpdateNodeExecutionPatch,
  ): Promise<PipelineNodeExecution | null> {
    return pipelineNodeExecutions.update(
      this.operationalSessions(),
      id,
      patch,
    );
  }
}
