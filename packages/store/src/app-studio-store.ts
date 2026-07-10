/**
 * AppStudioStore — CRUD das sessões e features do App Studio (migration
 * 200). Dual-mode constructor (path | DB handle), mesmo padrão do
 * DesignSystemStore.
 *
 * Duas entidades:
 *   - **session** → 1 por projeto App Studio (UNIQUE project_id); carrega
 *     a config imutável do scaffold + spec/pipeline/interview/deploy JSON.
 *   - **feature** → deliverables registrados pelo agente
 *     (app_record_feature); progresso do roadmap deriva por name-match.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type AppStudioStack = 'cf-fullstack';
export type AppStudioDbEngine = 'd1' | 'postgres' | 'mysql';
export type AppStudioFeatureKind = 'screen' | 'api' | 'feature';
export type AppStudioSpecRevisionStatus = 'draft' | 'approved' | 'superseded' | 'rejected';
export type AppStudioEvolutionStatus = 'draft' | 'review' | 'approved' | 'applied' | 'rejected';
export type AppStudioArchitectureRevisionStatus = 'draft' | 'approved' | 'superseded' | 'rejected';

export interface AppStudioSession {
  id: number;
  project_id: number;
  name: string;
  /** Worker name (wrangler `name`) — imutável pós-scaffold. */
  app_slug: string;
  stack: AppStudioStack;
  db_engine: AppStudioDbEngine;
  spec_json: string | null;
  pipeline_json: string | null;
  deploy_json: string | null;
  /** Layout do canvas Blueprint (posições; mig 201). */
  blueprint_json: string | null;
  created_at: string;
}

export interface AppStudioFeature {
  id: number;
  app_session_id: number;
  name: string;
  kind: AppStudioFeatureKind;
  summary: string | null;
  verified_in_preview: boolean;
  created_at: string;
}

export interface AppStudioSpecRevision {
  id: number;
  app_session_id: number;
  revision_number: number;
  base_revision_id: number | null;
  status: AppStudioSpecRevisionStatus;
  title: string | null;
  summary: string | null;
  change_reason: string | null;
  spec_json: string;
  diff_json: string | null;
  impact_json: string | null;
  created_by: string;
  coder_session_id: number | null;
  created_at: string;
  approved_at: string | null;
}

export interface AppStudioEvolution {
  id: number;
  app_session_id: number;
  base_revision_id: number | null;
  proposed_revision_id: number | null;
  title: string;
  description: string | null;
  status: AppStudioEvolutionStatus;
  impact_json: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  applied_at: string | null;
}

export interface AppStudioArchitectureRevision {
  id: number;
  app_session_id: number;
  spec_revision_id: number | null;
  revision_number: number;
  status: AppStudioArchitectureRevisionStatus;
  architecture_json: string;
  created_by: string;
  coder_session_id: number | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

export interface AppStudioPipelineRepair {
  id: number;
  app_session_id: number;
  before_pipeline_json: string | null;
  after_pipeline_json: string;
  report_json: string;
  created_at: string;
  undone_at: string | null;
}

export interface CreateAppStudioSessionInput {
  project_id: number;
  name: string;
  app_slug: string;
  db_engine?: AppStudioDbEngine;
}

export interface UpsertAppStudioFeatureInput {
  app_session_id: number;
  name: string;
  kind: AppStudioFeatureKind;
  summary?: string | null;
  verified_in_preview?: boolean;
}

export interface CreateAppStudioSpecRevisionInput {
  app_session_id: number;
  spec_json: string;
  status?: AppStudioSpecRevisionStatus;
  title?: string | null;
  summary?: string | null;
  change_reason?: string | null;
  base_revision_id?: number | null;
  diff_json?: string | null;
  impact_json?: string | null;
  created_by?: string | null;
  coder_session_id?: number | null;
}

export interface CreateAppStudioEvolutionInput {
  app_session_id: number;
  title: string;
  description?: string | null;
  base_revision_id?: number | null;
  impact_json?: string | null;
}

export interface UpdateAppStudioEvolutionInput {
  status?: AppStudioEvolutionStatus;
  proposed_revision_id?: number | null;
  impact_json?: string | null;
  submitted_at?: string | null;
  approved_at?: string | null;
  applied_at?: string | null;
}

export interface SaveAppStudioArchitectureRevisionInput {
  app_session_id: number;
  spec_revision_id?: number | null;
  architecture_json: string;
  created_by?: string | null;
  coder_session_id?: number | null;
}

interface SessionRow {
  id: number;
  project_id: number;
  name: string;
  app_slug: string;
  stack: string;
  db_engine: string;
  spec_json: string | null;
  pipeline_json: string | null;
  deploy_json: string | null;
  blueprint_json: string | null;
  created_at: string;
}

interface FeatureRow {
  id: number;
  app_session_id: number;
  name: string;
  kind: string;
  summary: string | null;
  verified_in_preview: number;
  created_at: string;
}

interface SpecRevisionRow {
  id: number;
  app_session_id: number;
  revision_number: number;
  base_revision_id: number | null;
  status: string;
  title: string | null;
  summary: string | null;
  change_reason: string | null;
  spec_json: string;
  diff_json: string | null;
  impact_json: string | null;
  created_by: string;
  coder_session_id: number | null;
  created_at: string;
  approved_at: string | null;
}

interface EvolutionRow {
  id: number;
  app_session_id: number;
  base_revision_id: number | null;
  proposed_revision_id: number | null;
  title: string;
  description: string | null;
  status: string;
  impact_json: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  applied_at: string | null;
}

interface ArchitectureRevisionRow {
  id: number;
  app_session_id: number;
  spec_revision_id: number | null;
  revision_number: number;
  status: string;
  architecture_json: string;
  created_by: string;
  coder_session_id: number | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

interface PipelineRepairRow {
  id: number;
  app_session_id: number;
  before_pipeline_json: string | null;
  after_pipeline_json: string;
  report_json: string;
  created_at: string;
  undone_at: string | null;
}

function hydrateSession(r: SessionRow): AppStudioSession {
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    app_slug: r.app_slug,
    stack: r.stack as AppStudioStack,
    db_engine: r.db_engine as AppStudioDbEngine,
    spec_json: r.spec_json ?? null,
    pipeline_json: r.pipeline_json ?? null,
    deploy_json: r.deploy_json ?? null,
    blueprint_json: r.blueprint_json ?? null,
    created_at: r.created_at,
  };
}

function hydrateFeature(r: FeatureRow): AppStudioFeature {
  return {
    id: r.id,
    app_session_id: r.app_session_id,
    name: r.name,
    kind: r.kind as AppStudioFeatureKind,
    summary: r.summary,
    verified_in_preview: !!r.verified_in_preview,
    created_at: r.created_at,
  };
}

function hydratePipelineRepair(r: PipelineRepairRow): AppStudioPipelineRepair {
  return {
    id: r.id,
    app_session_id: r.app_session_id,
    before_pipeline_json: r.before_pipeline_json,
    after_pipeline_json: r.after_pipeline_json,
    report_json: r.report_json,
    created_at: r.created_at,
    undone_at: r.undone_at,
  };
}

function hydrateSpecRevision(r: SpecRevisionRow): AppStudioSpecRevision {
  return {
    id: r.id,
    app_session_id: r.app_session_id,
    revision_number: r.revision_number,
    base_revision_id: r.base_revision_id,
    status: r.status as AppStudioSpecRevisionStatus,
    title: r.title,
    summary: r.summary,
    change_reason: r.change_reason,
    spec_json: r.spec_json,
    diff_json: r.diff_json,
    impact_json: r.impact_json,
    created_by: r.created_by,
    coder_session_id: r.coder_session_id,
    created_at: r.created_at,
    approved_at: r.approved_at,
  };
}

function hydrateEvolution(r: EvolutionRow): AppStudioEvolution {
  return {
    id: r.id,
    app_session_id: r.app_session_id,
    base_revision_id: r.base_revision_id,
    proposed_revision_id: r.proposed_revision_id,
    title: r.title,
    description: r.description,
    status: r.status as AppStudioEvolutionStatus,
    impact_json: r.impact_json,
    created_at: r.created_at,
    submitted_at: r.submitted_at,
    approved_at: r.approved_at,
    applied_at: r.applied_at,
  };
}

function hydrateArchitectureRevision(r: ArchitectureRevisionRow): AppStudioArchitectureRevision {
  return {
    ...r,
    status: r.status as AppStudioArchitectureRevisionStatus,
  };
}

export class AppStudioStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrHandle: string | DB) {
    if (typeof dbPathOrHandle === 'string') {
      this.db = new Database(dbPathOrHandle);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrHandle;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  // ── Sessions ──────────────────────────────────────────────────────

  createSession(input: CreateAppStudioSessionInput): AppStudioSession {
    const info = this.db
      .prepare(
        `INSERT INTO app_studio_sessions (project_id, name, app_slug, db_engine)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.project_id, input.name, input.app_slug, input.db_engine ?? 'd1');
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  getSession(id: number): AppStudioSession | null {
    const row = this.db
      .prepare('SELECT * FROM app_studio_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ? hydrateSession(row) : null;
  }

  getSessionByProjectId(projectId: number): AppStudioSession | null {
    const row = this.db
      .prepare('SELECT * FROM app_studio_sessions WHERE project_id = ?')
      .get(projectId) as SessionRow | undefined;
    return row ? hydrateSession(row) : null;
  }

  listSessions(): AppStudioSession[] {
    const rows = this.db
      .prepare('SELECT * FROM app_studio_sessions ORDER BY created_at DESC')
      .all() as SessionRow[];
    return rows.map(hydrateSession);
  }

  private setColumn(id: number, column: 'spec_json' | 'pipeline_json' | 'deploy_json' | 'blueprint_json', json: string | null): AppStudioSession {
    this.db.prepare(`UPDATE app_studio_sessions SET ${column} = ? WHERE id = ?`).run(json, id);
    return this.getSession(id)!;
  }

  setSpecJson(id: number, json: string | null): AppStudioSession {
    return this.setColumn(id, 'spec_json', json);
  }

  setPipelineJson(id: number, json: string | null): AppStudioSession {
    return this.setColumn(id, 'pipeline_json', json);
  }

  setDeployJson(id: number, json: string | null): AppStudioSession {
    return this.setColumn(id, 'deploy_json', json);
  }

  setBlueprintJson(id: number, json: string | null): AppStudioSession {
    return this.setColumn(id, 'blueprint_json', json);
  }

  deleteSession(id: number): void {
    // FK cascade só dispara com foreign_keys ON — deleta filhos explicitamente.
    this.db.prepare('DELETE FROM app_studio_pipeline_repairs WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_architecture_revisions WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_evolutions WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_spec_revisions WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_features WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_sessions WHERE id = ?').run(id);
  }

  // ── Pipeline repair history ───────────────────────────────────────

  getPipelineRepair(id: number): AppStudioPipelineRepair | null {
    const row = this.db
      .prepare('SELECT * FROM app_studio_pipeline_repairs WHERE id = ?')
      .get(id) as PipelineRepairRow | undefined;
    return row ? hydratePipelineRepair(row) : null;
  }

  applyPipelineRepair(input: {
    app_session_id: number;
    before_pipeline_json: string | null;
    after_pipeline_json: string;
    report_json: string;
  }): { session: AppStudioSession; repair: AppStudioPipelineRepair } {
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT pipeline_json FROM app_studio_sessions WHERE id = ?')
        .get(input.app_session_id) as { pipeline_json: string | null } | undefined;
      if (!current) throw new Error(`App Studio session ${input.app_session_id} not found.`);
      if (current.pipeline_json !== input.before_pipeline_json) {
        throw new Error('The journey changed after the repair preview. Run the check again before applying.');
      }
      const info = this.db
        .prepare(
          `INSERT INTO app_studio_pipeline_repairs
             (app_session_id, before_pipeline_json, after_pipeline_json, report_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.app_session_id, input.before_pipeline_json, input.after_pipeline_json, input.report_json);
      this.db
        .prepare('UPDATE app_studio_sessions SET pipeline_json = ? WHERE id = ?')
        .run(input.after_pipeline_json, input.app_session_id);
      return Number(info.lastInsertRowid);
    });
    const repairId = tx();
    return { session: this.getSession(input.app_session_id)!, repair: this.getPipelineRepair(repairId)! };
  }

  undoPipelineRepair(sessionId: number, repairId: number): { session: AppStudioSession; repair: AppStudioPipelineRepair } {
    const tx = this.db.transaction(() => {
      const repair = this.db
        .prepare('SELECT * FROM app_studio_pipeline_repairs WHERE id = ? AND app_session_id = ?')
        .get(repairId, sessionId) as PipelineRepairRow | undefined;
      if (!repair) throw new Error(`Pipeline repair ${repairId} not found for app session ${sessionId}.`);
      if (repair.undone_at) throw new Error('This repair was already undone.');
      const current = this.db
        .prepare('SELECT pipeline_json FROM app_studio_sessions WHERE id = ?')
        .get(sessionId) as { pipeline_json: string | null } | undefined;
      if (!current) throw new Error(`App Studio session ${sessionId} not found.`);
      if (current.pipeline_json !== repair.after_pipeline_json) {
        throw new Error('The journey changed after this repair, so it cannot be undone safely.');
      }
      this.db
        .prepare('UPDATE app_studio_sessions SET pipeline_json = ? WHERE id = ?')
        .run(repair.before_pipeline_json, sessionId);
      this.db
        .prepare("UPDATE app_studio_pipeline_repairs SET undone_at = datetime('now') WHERE id = ?")
        .run(repairId);
    });
    tx();
    return { session: this.getSession(sessionId)!, repair: this.getPipelineRepair(repairId)! };
  }

  // ── Spec revisions / product evolutions ───────────────────────────

  listSpecRevisions(sessionId: number): AppStudioSpecRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM app_studio_spec_revisions WHERE app_session_id = ? ORDER BY revision_number DESC')
      .all(sessionId) as SpecRevisionRow[];
    return rows.map(hydrateSpecRevision);
  }

  getSpecRevision(id: number): AppStudioSpecRevision | null {
    const row = this.db
      .prepare('SELECT * FROM app_studio_spec_revisions WHERE id = ?')
      .get(id) as SpecRevisionRow | undefined;
    return row ? hydrateSpecRevision(row) : null;
  }

  getLatestApprovedSpecRevision(sessionId: number): AppStudioSpecRevision | null {
    const row = this.db
      .prepare(
        `SELECT * FROM app_studio_spec_revisions
         WHERE app_session_id = ? AND status = 'approved'
         ORDER BY revision_number DESC LIMIT 1`,
      )
      .get(sessionId) as SpecRevisionRow | undefined;
    return row ? hydrateSpecRevision(row) : null;
  }

  /**
   * The draft currently attached to an evolution that is genuinely waiting
   * for user review. Historical/orphan drafts must never block later stages.
   */
  getPendingSpecRevision(sessionId: number): AppStudioSpecRevision | null {
    const row = this.db
      .prepare(
        `SELECT revision.*
         FROM app_studio_spec_revisions revision
         JOIN app_studio_evolutions evolution ON evolution.proposed_revision_id = revision.id
         WHERE evolution.app_session_id = ?
           AND evolution.status = 'review'
           AND revision.status = 'draft'
         ORDER BY evolution.submitted_at DESC, evolution.id DESC
         LIMIT 1`,
      )
      .get(sessionId) as SpecRevisionRow | undefined;
    return row ? hydrateSpecRevision(row) : null;
  }

  createSpecRevision(input: CreateAppStudioSpecRevisionInput): AppStudioSpecRevision {
    const tx = this.db.transaction((payload: CreateAppStudioSpecRevisionInput) => {
      const next = this.nextSpecRevisionNumber(payload.app_session_id);
      const info = this.db
        .prepare(
          `INSERT INTO app_studio_spec_revisions (
             app_session_id, revision_number, base_revision_id, status, title, summary,
             change_reason, spec_json, diff_json, impact_json, created_by, coder_session_id,
             approved_at
           ) VALUES (
             @app_session_id, @revision_number, @base_revision_id, @status, @title, @summary,
             @change_reason, @spec_json, @diff_json, @impact_json, @created_by, @coder_session_id,
             CASE WHEN @status = 'approved' THEN datetime('now') ELSE NULL END
           )`,
        )
        .run({
          app_session_id: payload.app_session_id,
          revision_number: next,
          base_revision_id: payload.base_revision_id ?? null,
          status: payload.status ?? 'draft',
          title: payload.title ?? null,
          summary: payload.summary ?? null,
          change_reason: payload.change_reason ?? null,
          spec_json: payload.spec_json,
          diff_json: payload.diff_json ?? null,
          impact_json: payload.impact_json ?? null,
          created_by: payload.created_by ?? 'system',
          coder_session_id: payload.coder_session_id ?? null,
        });
      if ((payload.status ?? 'draft') === 'approved') {
        this.db
          .prepare(
            `UPDATE app_studio_spec_revisions
             SET status = 'superseded'
             WHERE app_session_id = ? AND id <> ? AND status = 'approved'`,
          )
          .run(payload.app_session_id, Number(info.lastInsertRowid));
      }
      return Number(info.lastInsertRowid);
    });
    const id = tx(input);
    return this.getSpecRevision(id)!;
  }

  ensureInitialSpecRevision(
    sessionId: number,
    input: { title?: string | null; summary?: string | null; created_by?: string | null } = {},
  ): AppStudioSpecRevision | null {
    const approved = this.getLatestApprovedSpecRevision(sessionId);
    if (approved) return approved;
    const session = this.getSession(sessionId);
    if (!session?.spec_json) return null;
    const existing = this.db
      .prepare('SELECT COUNT(1) as n FROM app_studio_spec_revisions WHERE app_session_id = ?')
      .get(sessionId) as { n: number };
    if (existing.n > 0) {
      return this.createSpecRevision({
        app_session_id: sessionId,
        status: 'approved',
        title: input.title ?? 'Versão atual',
        summary: input.summary ?? 'Spec atual registrada como versão aprovada.',
        spec_json: session.spec_json,
        created_by: input.created_by ?? 'system',
      });
    }
    return this.createSpecRevision({
      app_session_id: sessionId,
      status: 'approved',
      title: input.title ?? 'Versão inicial',
      summary: input.summary ?? 'Primeiro plano aprovado do app.',
      spec_json: session.spec_json,
      created_by: input.created_by ?? 'system',
    });
  }

  approveSpecRevision(sessionId: number, revisionId: number): AppStudioSpecRevision {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM app_studio_spec_revisions WHERE id = ? AND app_session_id = ?')
        .get(revisionId, sessionId) as SpecRevisionRow | undefined;
      if (!row) throw new Error(`Spec revision ${revisionId} not found for app session ${sessionId}.`);
      this.db
        .prepare(
          `UPDATE app_studio_spec_revisions
           SET status = 'superseded'
           WHERE app_session_id = ? AND id <> ? AND status = 'approved'`,
        )
        .run(sessionId, revisionId);
      this.db
        .prepare("UPDATE app_studio_spec_revisions SET status = 'approved', approved_at = datetime('now') WHERE id = ?")
        .run(revisionId);
      this.db.prepare('UPDATE app_studio_sessions SET spec_json = ? WHERE id = ?').run(row.spec_json, sessionId);
    });
    tx();
    return this.getSpecRevision(revisionId)!;
  }

  updateSpecRevisionStatus(id: number, status: AppStudioSpecRevisionStatus): AppStudioSpecRevision {
    this.db.prepare('UPDATE app_studio_spec_revisions SET status = ? WHERE id = ?').run(status, id);
    const revision = this.getSpecRevision(id);
    if (!revision) throw new Error(`Spec revision ${id} not found.`);
    return revision;
  }

  createEvolution(input: CreateAppStudioEvolutionInput): AppStudioEvolution {
    const info = this.db
      .prepare(
        `INSERT INTO app_studio_evolutions (app_session_id, base_revision_id, title, description, impact_json)
         VALUES (@app_session_id, @base_revision_id, @title, @description, @impact_json)`,
      )
      .run({
        app_session_id: input.app_session_id,
        base_revision_id: input.base_revision_id ?? null,
        title: input.title,
        description: input.description ?? null,
        impact_json: input.impact_json ?? null,
      });
    return this.getEvolution(Number(info.lastInsertRowid))!;
  }

  getEvolution(id: number): AppStudioEvolution | null {
    const row = this.db
      .prepare('SELECT * FROM app_studio_evolutions WHERE id = ?')
      .get(id) as EvolutionRow | undefined;
    return row ? hydrateEvolution(row) : null;
  }

  listEvolutions(sessionId: number): AppStudioEvolution[] {
    const rows = this.db
      .prepare('SELECT * FROM app_studio_evolutions WHERE app_session_id = ? ORDER BY created_at DESC, id DESC')
      .all(sessionId) as EvolutionRow[];
    return rows.map(hydrateEvolution);
  }

  updateEvolution(id: number, input: UpdateAppStudioEvolutionInput): AppStudioEvolution {
    const tx = this.db.transaction(() => {
      const current = this.getEvolution(id);
      if (!current) throw new Error(`App Studio evolution ${id} not found.`);
      const next = {
        status: input.status ?? current.status,
        proposed_revision_id: input.proposed_revision_id ?? current.proposed_revision_id,
        impact_json: input.impact_json ?? current.impact_json,
        submitted_at: input.submitted_at ?? current.submitted_at,
        approved_at: input.approved_at ?? current.approved_at,
        applied_at: input.applied_at ?? current.applied_at,
      };

      if (
        current.proposed_revision_id &&
        next.proposed_revision_id &&
        current.proposed_revision_id !== next.proposed_revision_id
      ) {
        this.db
          .prepare(
            `UPDATE app_studio_spec_revisions
             SET status = 'superseded'
             WHERE id = ? AND app_session_id = ? AND status = 'draft'`,
          )
          .run(current.proposed_revision_id, current.app_session_id);
      }

      this.db
        .prepare(
          `UPDATE app_studio_evolutions
           SET status = @status,
               proposed_revision_id = @proposed_revision_id,
               impact_json = @impact_json,
               submitted_at = @submitted_at,
               approved_at = @approved_at,
               applied_at = @applied_at
           WHERE id = @id`,
        )
        .run({ id, ...next });
    });
    tx();
    return this.getEvolution(id)!;
  }

  /**
   * Most-recent OPEN, EMPTY evolution for a session — one that was created but
   * never got a proposed revision (`status='draft'` && `proposed_revision_id`
   * NULL). Used by `app_propose_spec_revision`'s auto-create path to REUSE an
   * empty container instead of spawning a duplicate row on retry.
   */
  findOpenEvolution(sessionId: number): AppStudioEvolution | null {
    const row = this.db
      .prepare(
        `SELECT * FROM app_studio_evolutions
         WHERE app_session_id = ? AND status = 'draft' AND proposed_revision_id IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as EvolutionRow | undefined;
    return row ? hydrateEvolution(row) : null;
  }

  /**
   * Delete a single evolution. Safe: no table has an inbound FK to
   * `app_studio_evolutions` (its own FKs point OUT to spec_revisions with
   * ON DELETE SET NULL). The UI only offers this for empty drafts.
   */
  deleteEvolution(id: number): void {
    this.db.prepare('DELETE FROM app_studio_evolutions WHERE id = ?').run(id);
  }

  private nextSpecRevisionNumber(sessionId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 as n FROM app_studio_spec_revisions WHERE app_session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }

  // ── Architecture revisions ────────────────────────────────────────

  listArchitectureRevisions(sessionId: number): AppStudioArchitectureRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM app_studio_architecture_revisions WHERE app_session_id = ? ORDER BY revision_number DESC')
      .all(sessionId) as ArchitectureRevisionRow[];
    return rows.map(hydrateArchitectureRevision);
  }

  getArchitectureRevision(id: number): AppStudioArchitectureRevision | null {
    const row = this.db
      .prepare('SELECT * FROM app_studio_architecture_revisions WHERE id = ?')
      .get(id) as ArchitectureRevisionRow | undefined;
    return row ? hydrateArchitectureRevision(row) : null;
  }

  getLatestArchitectureRevision(sessionId: number): AppStudioArchitectureRevision | null {
    const row = this.db
      .prepare(
        `SELECT * FROM app_studio_architecture_revisions
         WHERE app_session_id = ? AND status <> 'rejected'
         ORDER BY revision_number DESC LIMIT 1`,
      )
      .get(sessionId) as ArchitectureRevisionRow | undefined;
    return row ? hydrateArchitectureRevision(row) : null;
  }

  getLatestApprovedArchitectureRevision(sessionId: number): AppStudioArchitectureRevision | null {
    const row = this.db
      .prepare(
        `SELECT * FROM app_studio_architecture_revisions
         WHERE app_session_id = ? AND status = 'approved'
         ORDER BY revision_number DESC LIMIT 1`,
      )
      .get(sessionId) as ArchitectureRevisionRow | undefined;
    return row ? hydrateArchitectureRevision(row) : null;
  }

  saveArchitectureRevision(input: SaveAppStudioArchitectureRevisionInput): AppStudioArchitectureRevision {
    const tx = this.db.transaction((payload: SaveAppStudioArchitectureRevisionInput) => {
      const existing = this.db
        .prepare(
          `SELECT * FROM app_studio_architecture_revisions
           WHERE app_session_id = ? AND status = 'draft'
             AND ((spec_revision_id = ?) OR (spec_revision_id IS NULL AND ? IS NULL))
           ORDER BY revision_number DESC LIMIT 1`,
        )
        .get(payload.app_session_id, payload.spec_revision_id ?? null, payload.spec_revision_id ?? null) as ArchitectureRevisionRow | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE app_studio_architecture_revisions
             SET architecture_json = ?, created_by = ?, coder_session_id = ?, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(payload.architecture_json, payload.created_by ?? 'agent', payload.coder_session_id ?? null, existing.id);
        return existing.id;
      }
      const next = this.db
        .prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM app_studio_architecture_revisions WHERE app_session_id = ?')
        .get(payload.app_session_id) as { n: number };
      const info = this.db
        .prepare(
          `INSERT INTO app_studio_architecture_revisions (
             app_session_id, spec_revision_id, revision_number, architecture_json, created_by, coder_session_id
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payload.app_session_id,
          payload.spec_revision_id ?? null,
          next.n,
          payload.architecture_json,
          payload.created_by ?? 'agent',
          payload.coder_session_id ?? null,
        );
      return Number(info.lastInsertRowid);
    });
    return this.getArchitectureRevision(tx(input))!;
  }

  approveArchitectureRevision(sessionId: number, revisionId: number): AppStudioArchitectureRevision {
    const tx = this.db.transaction(() => {
      const revision = this.db
        .prepare('SELECT * FROM app_studio_architecture_revisions WHERE id = ? AND app_session_id = ?')
        .get(revisionId, sessionId) as ArchitectureRevisionRow | undefined;
      if (!revision) throw new Error(`Architecture revision ${revisionId} not found for app session ${sessionId}.`);
      this.db
        .prepare(
          `UPDATE app_studio_architecture_revisions SET status = 'superseded'
           WHERE app_session_id = ? AND id <> ? AND status = 'approved'`,
        )
        .run(sessionId, revisionId);
      this.db
        .prepare(
          `UPDATE app_studio_architecture_revisions
           SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(revisionId);
    });
    tx();
    return this.getArchitectureRevision(revisionId)!;
  }

  // ── Features ──────────────────────────────────────────────────────

  upsertFeature(input: UpsertAppStudioFeatureInput): AppStudioFeature {
    this.db
      .prepare(
        `INSERT INTO app_studio_features (app_session_id, name, kind, summary, verified_in_preview)
         VALUES (@app_session_id, @name, @kind, @summary, @verified)
         ON CONFLICT(app_session_id, name, kind) DO UPDATE SET
           summary = COALESCE(excluded.summary, app_studio_features.summary),
           verified_in_preview = excluded.verified_in_preview`,
      )
      .run({
        app_session_id: input.app_session_id,
        name: input.name,
        kind: input.kind,
        summary: input.summary ?? null,
        verified: input.verified_in_preview ? 1 : 0,
      });
    const row = this.db
      .prepare('SELECT * FROM app_studio_features WHERE app_session_id = ? AND name = ? AND kind = ?')
      .get(input.app_session_id, input.name, input.kind) as FeatureRow;
    return hydrateFeature(row);
  }

  listFeatures(sessionId: number): AppStudioFeature[] {
    const rows = this.db
      .prepare('SELECT * FROM app_studio_features WHERE app_session_id = ? ORDER BY kind, name')
      .all(sessionId) as FeatureRow[];
    return rows.map(hydrateFeature);
  }

  deleteFeaturesByKinds(sessionId: number, kinds: AppStudioFeatureKind[]): number {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => '?').join(', ');
    const result = this.db
      .prepare(`DELETE FROM app_studio_features WHERE app_session_id = ? AND kind IN (${placeholders})`)
      .run(sessionId, ...kinds);
    return result.changes ?? 0;
  }
}
