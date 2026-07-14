/**
 * AppStudioStore — workflow e artefatos do App Studio (migration
 * 200). Dual-mode constructor (path | DB handle), mesmo padrão do
 * DesignSystemStore.
 *
 * A sessão é única por projeto e mantém o workflow v5, suas revisões,
 * aprovações, decisões, cards, eventos e o coordenador persistente.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type AppStudioStack = 'cf-fullstack';
export type AppStudioDbEngine = 'd1' | 'postgres' | 'mysql';
export type AppStudioSpecRevisionStatus = 'draft' | 'approved' | 'superseded' | 'rejected';
export type AppStudioEvolutionStatus = 'draft' | 'review' | 'approved' | 'applied' | 'rejected';
export type AppStudioArchitectureRevisionStatus = 'draft' | 'approved' | 'superseded' | 'rejected';
export type AppStudioExperienceRevisionStatus = 'draft' | 'approved' | 'superseded' | 'rejected';
export type AppStudioProductRevisionStatus = 'draft' | 'approved' | 'superseded' | 'rejected';
export type AppStudioWorkItemStatus = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'blocked' | 'stale' | 'cancelled';
export type AppStudioWorkItemKind = 'research' | 'plan' | 'contract' | 'implement' | 'verify' | 'release' | 'change';
export type AppStudioWorkflowPhase = 'define' | 'blueprint' | 'build' | 'deliver';
export type AppStudioApprovalType = 'scope' | 'blueprint' | 'release';
export type AppStudioApprovalStatus = 'pending' | 'approved' | 'changes_requested' | 'superseded';

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
  /** Sessão única e persistente do coordenador App Studio v5. */
  coordinator_session_id: number | null;
  /** Configuração de perfis e prompts adicionais do time do app. */
  agent_config_json: string | null;
  created_at: string;
}

export interface AppStudioWorkItem {
  id: string; app_session_id: number; phase: AppStudioWorkflowPhase; slice_id: string | null;
  title: string; outcome: string; kind: AppStudioWorkItemKind; owner_profile: string;
  priority: number; revision: number; status: AppStudioWorkItemStatus; sort_order: number;
  depends_on_json: string; source_ids_json: string; acceptance_json: string; evidence_json: string;
  file_scope_json: string; blocked_reason: string | null; run_json: string | null;
  created_at: string; updated_at: string;
}

export interface UpsertAppStudioWorkItemInput {
  id: string; app_session_id: number; phase: AppStudioWorkflowPhase; slice_id?: string | null;
  title: string; outcome?: string; kind: AppStudioWorkItemKind; owner_profile?: string;
  priority?: number; revision?: number; status?: AppStudioWorkItemStatus; sort_order?: number;
  depends_on_json?: string; source_ids_json?: string; acceptance_json?: string; evidence_json?: string;
  file_scope_json?: string; blocked_reason?: string | null; run_json?: string | null;
}

export interface AppStudioApproval {
  id: number; app_session_id: number; type: AppStudioApprovalType; status: AppStudioApprovalStatus;
  bundle_revision: number; bundle_json: string; summary: string; feedback: string | null;
  requested_at: string; resolved_at: string | null;
}

export interface AppStudioDecisionRequest {
  id: number; app_session_id: number; question: string; options_json: string;
  blocked_work_item_ids_json: string; status: 'open' | 'resolved'; answer: string | null;
  requested_at: string; resolved_at: string | null;
}

export interface AppStudioWorkflowEvent {
  id: number; app_session_id: number; kind: string; entity_type: string; entity_id: string;
  payload_json: string; idempotency_key: string | null; created_at: string;
}

export interface AppStudioDeliveryBlueprintRevision {
  id: number; app_session_id: number; revision_number: number; status: 'draft' | 'approved' | 'superseded';
  blueprint_json: string; created_at: string; approved_at: string | null;
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

export interface AppStudioProductRevision {
  id: number; app_session_id: number; base_revision_id: number | null; base_spec_revision_id: number | null;
  result_spec_revision_id: number | null; revision_number: number; status: AppStudioProductRevisionStatus;
  complexity: 'simple' | 'standard' | 'complex' | 'very-complex'; research_fingerprint: string; product_json: string;
  created_by: string; coder_session_id: number | null; created_at: string; updated_at: string; approved_at: string | null;
}

export interface AppStudioUxRevision {
  id: number; app_session_id: number; spec_revision_id: number | null; architecture_revision_id: number | null;
  revision_number: number; status: AppStudioExperienceRevisionStatus; data_fingerprint: string; ux_json: string;
  created_by: string; coder_session_id: number | null; created_at: string; updated_at: string; approved_at: string | null;
}

export interface AppStudioWireframeRevision {
  id: number; app_session_id: number; spec_revision_id: number | null; architecture_revision_id: number | null;
  ux_revision_id: number | null; revision_number: number; status: AppStudioExperienceRevisionStatus;
  data_fingerprint: string; wireframe_json: string; created_by: string; coder_session_id: number | null;
  created_at: string; updated_at: string; approved_at: string | null;
}

export interface CreateAppStudioSessionInput {
  project_id: number;
  name: string;
  app_slug: string;
  db_engine?: AppStudioDbEngine;
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

export interface SaveAppStudioProductRevisionInput {
  app_session_id: number; base_revision_id?: number | null; base_spec_revision_id?: number | null;
  complexity: AppStudioProductRevision['complexity']; research_fingerprint?: string; product_json: string;
  created_by?: string | null; coder_session_id?: number | null;
}

export interface SaveAppStudioUxRevisionInput {
  app_session_id: number; spec_revision_id?: number | null; architecture_revision_id?: number | null;
  data_fingerprint: string; ux_json: string; created_by?: string | null; coder_session_id?: number | null;
}

export interface SaveAppStudioWireframeRevisionInput {
  app_session_id: number; spec_revision_id?: number | null; architecture_revision_id?: number | null; ux_revision_id?: number | null;
  data_fingerprint: string; wireframe_json: string; created_by?: string | null; coder_session_id?: number | null;
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
  coordinator_session_id: number | null;
  agent_config_json: string | null;
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

type UxRevisionRow = AppStudioUxRevision;
type ProductRevisionRow = AppStudioProductRevision;
type WireframeRevisionRow = AppStudioWireframeRevision;

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
    coordinator_session_id: r.coordinator_session_id ?? null,
    agent_config_json: r.agent_config_json ?? null,
    created_at: r.created_at,
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

  private setColumn(id: number, column: 'spec_json' | 'pipeline_json' | 'deploy_json' | 'blueprint_json' | 'agent_config_json', json: string | null): AppStudioSession {
    this.db.prepare(`UPDATE app_studio_sessions SET ${column} = ? WHERE id = ?`).run(json, id);
    return this.getSession(id)!;
  }

  setSpecJson(id: number, json: string | null): AppStudioSession {
    return this.setColumn(id, 'spec_json', json);
  }

  setWorkflowStateJson(id: number, json: string | null): AppStudioSession {
    return this.setColumn(id, 'pipeline_json', json);
  }

  setDeployJson(id: number, json: string | null): AppStudioSession {
    return this.setColumn(id, 'deploy_json', json);
  }

  setBlueprintJson(id: number, json: string | null): AppStudioSession {
    return this.setColumn(id, 'blueprint_json', json);
  }

  setCoordinatorSessionId(id: number, coderSessionId: number | null): AppStudioSession {
    this.db.prepare('UPDATE app_studio_sessions SET coordinator_session_id = ? WHERE id = ?').run(coderSessionId, id);
    return this.getSession(id)!;
  }

  setAgentConfigJson(id: number, json: string): AppStudioSession {
    return this.setColumn(id, 'agent_config_json', json);
  }

  deleteSession(id: number): void {
    // FK cascade só dispara com foreign_keys ON — deleta filhos explicitamente.
    this.db.prepare('DELETE FROM app_studio_workflow_events WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_decision_requests WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_approvals WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_work_items WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_delivery_blueprints WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_workflow_snapshots WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_pipeline_repairs WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_product_revisions WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_architecture_revisions WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_evolutions WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_spec_revisions WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_features WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_sessions WHERE id = ?').run(id);
  }

  // ── Product model revisions ─────────────────────────────────────

  getLatestProductRevision(sessionId: number): AppStudioProductRevision | null {
    const row = this.db.prepare(
      "SELECT * FROM app_studio_product_revisions WHERE app_session_id = ? AND status <> 'rejected' ORDER BY revision_number DESC LIMIT 1",
    ).get(sessionId) as ProductRevisionRow | undefined;
    return row ? { ...row, status: row.status as AppStudioProductRevisionStatus } : null;
  }

  getLatestApprovedProductRevision(sessionId: number): AppStudioProductRevision | null {
    const row = this.db.prepare(
      "SELECT * FROM app_studio_product_revisions WHERE app_session_id = ? AND status = 'approved' ORDER BY revision_number DESC LIMIT 1",
    ).get(sessionId) as ProductRevisionRow | undefined;
    return row ? { ...row, status: row.status as AppStudioProductRevisionStatus } : null;
  }

  saveProductRevision(input: SaveAppStudioProductRevisionInput, expectedRevisionNumber?: number | null): AppStudioProductRevision {
    const tx = this.db.transaction((payload: SaveAppStudioProductRevisionInput) => {
      const existing = this.db.prepare(
        "SELECT id, revision_number FROM app_studio_product_revisions WHERE app_session_id = ? AND status = 'draft' ORDER BY revision_number DESC LIMIT 1",
      ).get(payload.app_session_id) as { id: number; revision_number: number } | undefined;
      if (existing) {
        if (expectedRevisionNumber != null && existing.revision_number !== expectedRevisionNumber) {
          throw new Error(`Product revision conflict: expected v${expectedRevisionNumber}, current draft is v${existing.revision_number}.`);
        }
        this.db.prepare(
          `UPDATE app_studio_product_revisions SET complexity = ?, research_fingerprint = ?, product_json = ?, created_by = ?, coder_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(payload.complexity, payload.research_fingerprint ?? '', payload.product_json, payload.created_by ?? 'agent', payload.coder_session_id ?? null, existing.id);
        return existing.id;
      }
      if (expectedRevisionNumber != null) throw new Error('Product revision conflict: no editable draft exists. Reload the product model.');
      const next = this.db.prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM app_studio_product_revisions WHERE app_session_id = ?').get(payload.app_session_id) as { n: number };
      const result = this.db.prepare(
        `INSERT INTO app_studio_product_revisions (app_session_id, base_revision_id, base_spec_revision_id, revision_number, complexity, research_fingerprint, product_json, created_by, coder_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(payload.app_session_id, payload.base_revision_id ?? null, payload.base_spec_revision_id ?? null, next.n, payload.complexity, payload.research_fingerprint ?? '', payload.product_json, payload.created_by ?? 'agent', payload.coder_session_id ?? null);
      return Number(result.lastInsertRowid);
    });
    const id = tx(input);
    return this.db.prepare('SELECT * FROM app_studio_product_revisions WHERE id = ?').get(id) as ProductRevisionRow;
  }

  applyProductRevisionToScope(input: {
    sessionId: number; revisionId: number; candidateSpecJson: string; workflowStateJson: string;
  }): { product: AppStudioProductRevision; spec: AppStudioSpecRevision; session: AppStudioSession } {
    const tx = this.db.transaction(() => {
      const product = this.db.prepare('SELECT * FROM app_studio_product_revisions WHERE id = ? AND app_session_id = ?').get(input.revisionId, input.sessionId) as ProductRevisionRow | undefined;
      if (!product || product.status !== 'draft') throw new Error('No draft product revision is ready for approval.');
      const current = this.db.prepare("SELECT id FROM app_studio_spec_revisions WHERE app_session_id = ? AND status = 'approved' ORDER BY revision_number DESC LIMIT 1").get(input.sessionId) as { id: number } | undefined;
      const next = this.db.prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM app_studio_spec_revisions WHERE app_session_id = ?').get(input.sessionId) as { n: number };
      this.db.prepare("UPDATE app_studio_spec_revisions SET status = 'superseded' WHERE app_session_id = ? AND status = 'approved'").run(input.sessionId);
      const specResult = this.db.prepare(
        `INSERT INTO app_studio_spec_revisions (app_session_id, revision_number, base_revision_id, status, title, summary, change_reason, spec_json, created_by, approved_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, 'user', datetime('now'))`,
      ).run(input.sessionId, next.n, current?.id ?? null, `Escopo do produto v${product.revision_number}`, 'Spec materializada a partir da modelagem do produto aprovada.', 'Modelagem profunda do produto', input.candidateSpecJson);
      const specId = Number(specResult.lastInsertRowid);
      this.db.prepare("UPDATE app_studio_product_revisions SET status = 'superseded' WHERE app_session_id = ? AND id <> ? AND status = 'approved'").run(input.sessionId, input.revisionId);
      this.db.prepare("UPDATE app_studio_product_revisions SET status = 'approved', result_spec_revision_id = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(specId, input.revisionId);
      this.db.prepare('UPDATE app_studio_sessions SET spec_json = ?, pipeline_json = ? WHERE id = ?').run(input.candidateSpecJson, input.workflowStateJson, input.sessionId);
      return specId;
    });
    const specId = tx();
    return {
      product: this.db.prepare('SELECT * FROM app_studio_product_revisions WHERE id = ?').get(input.revisionId) as ProductRevisionRow,
      spec: this.getSpecRevision(specId)!,
      session: this.getSession(input.sessionId)!,
    };
  }

  deleteDraftProductRevision(sessionId: number, revisionId: number): void {
    this.db.prepare("DELETE FROM app_studio_product_revisions WHERE id = ? AND app_session_id = ? AND status = 'draft'").run(revisionId, sessionId);
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
   * for the Scope gate. Historical/orphan drafts must never block unrelated cards.
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

  // ── UX and wireframe revisions ──────────────────────────────────

  getLatestUxRevision(sessionId: number): AppStudioUxRevision | null {
    const row = this.db.prepare(
      "SELECT * FROM app_studio_ux_revisions WHERE app_session_id = ? AND status <> 'rejected' ORDER BY revision_number DESC LIMIT 1",
    ).get(sessionId) as UxRevisionRow | undefined;
    return row ? { ...row, status: row.status as AppStudioExperienceRevisionStatus } : null;
  }

  getLatestApprovedUxRevision(sessionId: number): AppStudioUxRevision | null {
    const row = this.db.prepare(
      "SELECT * FROM app_studio_ux_revisions WHERE app_session_id = ? AND status = 'approved' ORDER BY revision_number DESC LIMIT 1",
    ).get(sessionId) as UxRevisionRow | undefined;
    return row ? { ...row, status: row.status as AppStudioExperienceRevisionStatus } : null;
  }

  saveUxRevision(input: SaveAppStudioUxRevisionInput): AppStudioUxRevision {
    const tx = this.db.transaction((payload: SaveAppStudioUxRevisionInput) => {
      const existing = this.db.prepare(
        `SELECT id FROM app_studio_ux_revisions WHERE app_session_id = ? AND status = 'draft'
         AND ((spec_revision_id = ?) OR (spec_revision_id IS NULL AND ? IS NULL))
         AND ((architecture_revision_id = ?) OR (architecture_revision_id IS NULL AND ? IS NULL))
         ORDER BY revision_number DESC LIMIT 1`,
      ).get(payload.app_session_id, payload.spec_revision_id ?? null, payload.spec_revision_id ?? null, payload.architecture_revision_id ?? null, payload.architecture_revision_id ?? null) as { id: number } | undefined;
      if (existing) {
        this.db.prepare(
          `UPDATE app_studio_ux_revisions SET ux_json = ?, data_fingerprint = ?, created_by = ?, coder_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(payload.ux_json, payload.data_fingerprint, payload.created_by ?? 'agent', payload.coder_session_id ?? null, existing.id);
        return existing.id;
      }
      const next = this.db.prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM app_studio_ux_revisions WHERE app_session_id = ?').get(payload.app_session_id) as { n: number };
      const result = this.db.prepare(
        `INSERT INTO app_studio_ux_revisions (app_session_id, spec_revision_id, architecture_revision_id, revision_number, data_fingerprint, ux_json, created_by, coder_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(payload.app_session_id, payload.spec_revision_id ?? null, payload.architecture_revision_id ?? null, next.n, payload.data_fingerprint, payload.ux_json, payload.created_by ?? 'agent', payload.coder_session_id ?? null);
      return Number(result.lastInsertRowid);
    });
    const id = tx(input);
    return this.db.prepare('SELECT * FROM app_studio_ux_revisions WHERE id = ?').get(id) as UxRevisionRow;
  }

  getLatestWireframeRevision(sessionId: number): AppStudioWireframeRevision | null {
    const row = this.db.prepare(
      "SELECT * FROM app_studio_wireframe_revisions WHERE app_session_id = ? AND status <> 'rejected' ORDER BY revision_number DESC LIMIT 1",
    ).get(sessionId) as WireframeRevisionRow | undefined;
    return row ? { ...row, status: row.status as AppStudioExperienceRevisionStatus } : null;
  }

  getLatestApprovedWireframeRevision(sessionId: number): AppStudioWireframeRevision | null {
    const row = this.db.prepare(
      "SELECT * FROM app_studio_wireframe_revisions WHERE app_session_id = ? AND status = 'approved' ORDER BY revision_number DESC LIMIT 1",
    ).get(sessionId) as WireframeRevisionRow | undefined;
    return row ? { ...row, status: row.status as AppStudioExperienceRevisionStatus } : null;
  }

  saveWireframeRevision(input: SaveAppStudioWireframeRevisionInput): AppStudioWireframeRevision {
    const tx = this.db.transaction((payload: SaveAppStudioWireframeRevisionInput) => {
      const existing = this.db.prepare(
        `SELECT id FROM app_studio_wireframe_revisions WHERE app_session_id = ? AND status = 'draft'
         AND ((ux_revision_id = ?) OR (ux_revision_id IS NULL AND ? IS NULL)) ORDER BY revision_number DESC LIMIT 1`,
      ).get(payload.app_session_id, payload.ux_revision_id ?? null, payload.ux_revision_id ?? null) as { id: number } | undefined;
      if (existing) {
        this.db.prepare(
          `UPDATE app_studio_wireframe_revisions SET wireframe_json = ?, data_fingerprint = ?, created_by = ?, coder_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(payload.wireframe_json, payload.data_fingerprint, payload.created_by ?? 'agent', payload.coder_session_id ?? null, existing.id);
        return existing.id;
      }
      const next = this.db.prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM app_studio_wireframe_revisions WHERE app_session_id = ?').get(payload.app_session_id) as { n: number };
      const result = this.db.prepare(
        `INSERT INTO app_studio_wireframe_revisions (app_session_id, spec_revision_id, architecture_revision_id, ux_revision_id, revision_number, data_fingerprint, wireframe_json, created_by, coder_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(payload.app_session_id, payload.spec_revision_id ?? null, payload.architecture_revision_id ?? null, payload.ux_revision_id ?? null, next.n, payload.data_fingerprint, payload.wireframe_json, payload.created_by ?? 'agent', payload.coder_session_id ?? null);
      return Number(result.lastInsertRowid);
    });
    const id = tx(input);
    return this.db.prepare('SELECT * FROM app_studio_wireframe_revisions WHERE id = ?').get(id) as WireframeRevisionRow;
  }

  /** One-shot compatibility reader used only while converting pre-v5 rows. */
  readLegacyBuildProgress(wireframeRevisionId: number): {
    groups: Array<{ group_id: string; status: 'pending' | 'active' | 'review' | 'approved' }>;
    tasks: Array<{ task_id: string; status: 'pending' | 'active' | 'done'; summary: string | null; evidence_json: string | null }>;
  } {
    return {
      groups: this.db.prepare('SELECT group_id, status FROM app_studio_build_groups WHERE wireframe_revision_id = ? ORDER BY id')
        .all(wireframeRevisionId) as Array<{ group_id: string; status: 'pending' | 'active' | 'review' | 'approved' }>,
      tasks: this.db.prepare('SELECT task_id, status, summary, evidence_json FROM app_studio_build_task_evidence WHERE wireframe_revision_id = ? ORDER BY id')
        .all(wireframeRevisionId) as Array<{ task_id: string; status: 'pending' | 'active' | 'done'; summary: string | null; evidence_json: string | null }>,
    };
  }

  // ── Workflow v5 ──────────────────────────────────────────────────

  listWorkItems(sessionId: number): AppStudioWorkItem[] {
    return this.db.prepare(
      'SELECT * FROM app_studio_work_items WHERE app_session_id = ? ORDER BY status, sort_order, priority, id',
    ).all(sessionId) as AppStudioWorkItem[];
  }

  getWorkItem(sessionId: number, id: string): AppStudioWorkItem | null {
    return (this.db.prepare(
      'SELECT * FROM app_studio_work_items WHERE app_session_id = ? AND id = ?',
    ).get(sessionId, id) as AppStudioWorkItem | undefined) ?? null;
  }

  upsertWorkItems(items: UpsertAppStudioWorkItemInput[]): AppStudioWorkItem[] {
    const statement = this.db.prepare(`
      INSERT INTO app_studio_work_items (
        id, app_session_id, phase, slice_id, title, outcome, kind, owner_profile,
        priority, revision, status, sort_order, depends_on_json, source_ids_json,
        acceptance_json, evidence_json, file_scope_json, blocked_reason, run_json
      ) VALUES (
        @id, @app_session_id, @phase, @slice_id, @title, @outcome, @kind, @owner_profile,
        @priority, @revision, @status, @sort_order, @depends_on_json, @source_ids_json,
        @acceptance_json, @evidence_json, @file_scope_json, @blocked_reason, @run_json
      )
      ON CONFLICT(app_session_id, id) DO UPDATE SET
        phase = excluded.phase, slice_id = excluded.slice_id, title = excluded.title,
        outcome = excluded.outcome, kind = excluded.kind, owner_profile = excluded.owner_profile,
        priority = excluded.priority, revision = MAX(app_studio_work_items.revision, excluded.revision), sort_order = excluded.sort_order,
        status = CASE WHEN app_studio_work_items.status IN ('backlog','ready') THEN excluded.status ELSE app_studio_work_items.status END,
        depends_on_json = excluded.depends_on_json, source_ids_json = excluded.source_ids_json,
        acceptance_json = excluded.acceptance_json, file_scope_json = excluded.file_scope_json,
        blocked_reason = CASE WHEN app_studio_work_items.status IN ('backlog','ready') THEN excluded.blocked_reason ELSE app_studio_work_items.blocked_reason END,
        updated_at = datetime('now')
    `);
    const tx = this.db.transaction(() => {
      for (const item of items) {
        statement.run({
          ...item,
          slice_id: item.slice_id ?? null,
          outcome: item.outcome ?? '',
          owner_profile: item.owner_profile ?? 'coordinator',
          priority: item.priority ?? 2,
          revision: item.revision ?? 1,
          status: item.status ?? 'backlog',
          sort_order: item.sort_order ?? 0,
          depends_on_json: item.depends_on_json ?? '[]',
          source_ids_json: item.source_ids_json ?? '[]',
          acceptance_json: item.acceptance_json ?? '[]',
          evidence_json: item.evidence_json ?? '[]',
          file_scope_json: item.file_scope_json ?? '[]',
          blocked_reason: item.blocked_reason ?? null,
          run_json: item.run_json ?? null,
        });
      }
    });
    tx();
    for (const sessionId of new Set(items.map((item) => item.app_session_id))) {
      this.appendWorkflowEvent(sessionId, 'work_item.upserted', 'work_item', String(sessionId), JSON.stringify({
        ids: items.filter((item) => item.app_session_id === sessionId).map((item) => item.id),
      }));
    }
    return items.map((item) => this.getWorkItem(item.app_session_id, item.id)!).filter(Boolean);
  }

  setWorkItemStatus(sessionId: number, id: string, status: AppStudioWorkItemStatus, options?: {
    blockedReason?: string | null; evidenceJson?: string; runJson?: string | null;
  }): AppStudioWorkItem {
    const current = this.getWorkItem(sessionId, id);
    if (!current) throw new Error(`Work item '${id}' not found for app session ${sessionId}.`);
    if (status === 'done') {
      const evidence = JSON.parse(options?.evidenceJson ?? current.evidence_json) as unknown[];
      if (!Array.isArray(evidence) || evidence.length === 0) throw new Error(`Work item '${id}' needs evidence before it can be done.`);
      const valid = evidence.every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const record = entry as Record<string, unknown>;
        return typeof record.kind === 'string' && record.kind.trim().length > 0
          && typeof record.value === 'string' && record.value.trim().length > 0;
      });
      if (!valid) throw new Error(`Work item '${id}' needs auditable evidence with non-empty kind and value.`);
    }
    this.db.prepare(`
      UPDATE app_studio_work_items SET status = ?, blocked_reason = ?,
        evidence_json = COALESCE(?, evidence_json), run_json = COALESCE(?, run_json), updated_at = datetime('now')
      WHERE app_session_id = ? AND id = ?
    `).run(status, options?.blockedReason ?? null, options?.evidenceJson ?? null, options?.runJson ?? null, sessionId, id);
    this.appendWorkflowEvent(sessionId, 'work_item.status_changed', 'work_item', id, JSON.stringify({ status }));
    return this.getWorkItem(sessionId, id)!;
  }

  reorderWorkItem(sessionId: number, id: string, sortOrder: number): AppStudioWorkItem {
    const item = this.getWorkItem(sessionId, id);
    if (!item) throw new Error(`Work item '${id}' not found.`);
    if (item.status !== 'backlog' && item.status !== 'ready') throw new Error('Only backlog or ready work can be reordered.');
    const siblings = this.listWorkItems(sessionId)
      .filter((candidate) => candidate.status === item.status)
      .sort((a, b) => a.sort_order - b.sort_order || a.priority - b.priority || a.id.localeCompare(b.id));
    const currentIndex = siblings.findIndex((candidate) => candidate.id === id);
    siblings.splice(currentIndex, 1);
    const targetIndex = Math.min(siblings.length, Math.max(0, Math.trunc(sortOrder)));
    siblings.splice(targetIndex, 0, item);
    const update = this.db.prepare('UPDATE app_studio_work_items SET sort_order = ?, updated_at = datetime(\'now\') WHERE app_session_id = ? AND id = ?');
    this.db.transaction(() => siblings.forEach((candidate, index) => update.run(index, sessionId, candidate.id)))();
    this.appendWorkflowEvent(sessionId, 'work_item.reordered', 'work_item', id, JSON.stringify({ sort_order: targetIndex }));
    return this.getWorkItem(sessionId, id)!;
  }

  markWorkItemsStale(sessionId: number, ids: string[], reason: string): number {
    const statement = this.db.prepare(`
      UPDATE app_studio_work_items SET status = 'stale', blocked_reason = ?, revision = revision + 1, updated_at = datetime('now')
      WHERE app_session_id = ? AND id = ? AND status NOT IN ('cancelled', 'stale')
    `);
    const tx = this.db.transaction(() => ids.reduce((count, id) => count + statement.run(reason, sessionId, id).changes, 0));
    const changed = tx();
    if (changed > 0) this.appendWorkflowEvent(sessionId, 'work_item.status_changed', 'work_item', String(sessionId), JSON.stringify({ ids, status: 'stale' }));
    return changed;
  }

  refreshReadyWorkItems(sessionId: number): AppStudioWorkItem[] {
    const items = this.listWorkItems(sessionId);
    const done = new Set(items.filter((item) => item.status === 'done').map((item) => item.id));
    const review = new Set(items.filter((item) => item.status === 'review').map((item) => item.id));
    const cancelled = new Set(items.filter((item) => item.status === 'cancelled').map((item) => item.id));
    const update = this.db.prepare("UPDATE app_studio_work_items SET status = 'ready', blocked_reason = NULL, updated_at = datetime('now') WHERE app_session_id = ? AND id = ? AND status = 'backlog'");
    const block = this.db.prepare("UPDATE app_studio_work_items SET status = 'blocked', blocked_reason = ?, updated_at = datetime('now') WHERE app_session_id = ? AND id = ? AND status = 'backlog'");
    const readyIds: string[] = [];
    const blockedIds: string[] = [];
    const tx = this.db.transaction(() => {
      for (const item of items) {
        if (item.status !== 'backlog') continue;
        const dependencies = JSON.parse(item.depends_on_json) as string[];
        const cancelledDependency = dependencies.find((dependency) => cancelled.has(dependency));
        if (cancelledDependency) {
          if (block.run(`Dependency '${cancelledDependency}' was cancelled.`, sessionId, item.id).changes > 0) blockedIds.push(item.id);
          continue;
        }
        const satisfied = dependencies.every((dependency) => done.has(dependency) || (item.kind === 'verify' && review.has(dependency)));
        if (satisfied && update.run(sessionId, item.id).changes > 0) readyIds.push(item.id);
      }
    });
    tx();
    if (readyIds.length > 0) this.appendWorkflowEvent(sessionId, 'work_item.status_changed', 'work_item', String(sessionId), JSON.stringify({ ids: readyIds, status: 'ready' }));
    if (blockedIds.length > 0) this.appendWorkflowEvent(sessionId, 'work_item.status_changed', 'work_item', String(sessionId), JSON.stringify({ ids: blockedIds, status: 'blocked' }));
    return this.listWorkItems(sessionId);
  }

  listApprovals(sessionId: number): AppStudioApproval[] {
    return this.db.prepare('SELECT * FROM app_studio_approvals WHERE app_session_id = ? ORDER BY requested_at, id').all(sessionId) as AppStudioApproval[];
  }

  requestApproval(input: { sessionId: number; type: AppStudioApprovalType; bundleRevision: number; bundleJson: string; summary: string }): AppStudioApproval {
    const tx = this.db.transaction(() => {
      const matchingPending = this.db.prepare("SELECT id FROM app_studio_approvals WHERE app_session_id = ? AND type = ? AND status = 'pending' AND bundle_json = ? ORDER BY id DESC LIMIT 1")
        .get(input.sessionId, input.type, input.bundleJson) as { id: number } | undefined;
      if (matchingPending) return { id: matchingPending.id, changed: false };
      const latest = this.db.prepare('SELECT COALESCE(MAX(bundle_revision), 0) AS revision FROM app_studio_approvals WHERE app_session_id = ? AND type = ?')
        .get(input.sessionId, input.type) as { revision: number };
      if (input.bundleRevision <= latest.revision) throw new Error(`Approval ${input.type} requires a revision greater than ${latest.revision}.`);
      this.db.prepare("UPDATE app_studio_approvals SET status = 'superseded', resolved_at = COALESCE(resolved_at, datetime('now')) WHERE app_session_id = ? AND type = ? AND status <> 'superseded'")
        .run(input.sessionId, input.type);
      return {
        id: Number(this.db.prepare('INSERT INTO app_studio_approvals (app_session_id, type, bundle_revision, bundle_json, summary) VALUES (?, ?, ?, ?, ?)')
          .run(input.sessionId, input.type, input.bundleRevision, input.bundleJson, input.summary).lastInsertRowid),
        changed: true,
      };
    });
    const { id, changed } = tx();
    if (changed) this.appendWorkflowEvent(input.sessionId, 'approval.requested', 'approval', String(id), JSON.stringify({ type: input.type }));
    return this.db.prepare('SELECT * FROM app_studio_approvals WHERE id = ?').get(id) as AppStudioApproval;
  }

  resolveApproval(input: { sessionId: number; approvalId: number; decision: 'approve' | 'request_changes'; feedback?: string | null; idempotencyKey: string }): AppStudioApproval {
    const tx = this.db.transaction(() => {
      const approval = this.db.prepare('SELECT * FROM app_studio_approvals WHERE id = ? AND app_session_id = ?').get(input.approvalId, input.sessionId) as AppStudioApproval | undefined;
      if (!approval) throw new Error(`Approval ${input.approvalId} not found.`);
      if (approval.status !== 'pending') return approval;
      const status: AppStudioApprovalStatus = input.decision === 'approve' ? 'approved' : 'changes_requested';
      this.db.prepare('UPDATE app_studio_approvals SET status = ?, feedback = ?, resolved_at = datetime(\'now\') WHERE id = ?')
        .run(status, input.feedback?.trim() || null, approval.id);
      this.db.prepare(`INSERT OR IGNORE INTO app_studio_workflow_events
        (app_session_id, kind, entity_type, entity_id, payload_json, idempotency_key)
        VALUES (?, 'approval.resolved', 'approval', ?, ?, ?)`)
        .run(input.sessionId, String(approval.id), JSON.stringify({ decision: input.decision, type: approval.type }), input.idempotencyKey);
      return this.db.prepare('SELECT * FROM app_studio_approvals WHERE id = ?').get(approval.id) as AppStudioApproval;
    });
    return tx();
  }

  listDecisionRequests(sessionId: number): AppStudioDecisionRequest[] {
    return this.db.prepare('SELECT * FROM app_studio_decision_requests WHERE app_session_id = ? ORDER BY requested_at, id').all(sessionId) as AppStudioDecisionRequest[];
  }

  createDecisionRequest(input: { sessionId: number; question: string; optionsJson?: string; blockedWorkItemIdsJson?: string }): AppStudioDecisionRequest {
    const info = this.db.prepare(`INSERT INTO app_studio_decision_requests
      (app_session_id, question, options_json, blocked_work_item_ids_json) VALUES (?, ?, ?, ?)`)
      .run(input.sessionId, input.question, input.optionsJson ?? '[]', input.blockedWorkItemIdsJson ?? '[]');
    const id = Number(info.lastInsertRowid);
    this.appendWorkflowEvent(input.sessionId, 'decision.requested', 'decision', String(id), JSON.stringify({ question: input.question }));
    return this.db.prepare('SELECT * FROM app_studio_decision_requests WHERE id = ?').get(id) as AppStudioDecisionRequest;
  }

  resolveDecisionRequest(sessionId: number, id: number, answer: string): AppStudioDecisionRequest {
    const decision = this.db.prepare('SELECT * FROM app_studio_decision_requests WHERE id = ? AND app_session_id = ?').get(id, sessionId) as AppStudioDecisionRequest | undefined;
    if (!decision) throw new Error(`Decision ${id} not found.`);
    if (decision.status === 'resolved') {
      if (decision.answer === answer) return decision;
      throw new Error(`Decision ${id} was already resolved with a different answer.`);
    }
    this.db.prepare("UPDATE app_studio_decision_requests SET status = 'resolved', answer = ?, resolved_at = datetime('now') WHERE id = ?")
      .run(answer, id);
    const blockedIds = JSON.parse(decision.blocked_work_item_ids_json) as string[];
    const unblock = this.db.prepare("UPDATE app_studio_work_items SET status = 'backlog', blocked_reason = NULL, updated_at = datetime('now') WHERE app_session_id = ? AND id = ? AND status = 'blocked'");
    for (const workItemId of blockedIds) unblock.run(sessionId, workItemId);
    this.appendWorkflowEvent(sessionId, 'decision.resolved', 'decision', String(id), JSON.stringify({ answer }));
    return this.db.prepare('SELECT * FROM app_studio_decision_requests WHERE id = ?').get(id) as AppStudioDecisionRequest;
  }

  getLatestDeliveryBlueprint(sessionId: number): AppStudioDeliveryBlueprintRevision | null {
    return (this.db.prepare("SELECT * FROM app_studio_delivery_blueprints WHERE app_session_id = ? AND status <> 'superseded' ORDER BY revision_number DESC LIMIT 1")
      .get(sessionId) as AppStudioDeliveryBlueprintRevision | undefined) ?? null;
  }

  saveDeliveryBlueprint(sessionId: number, blueprintJson: string, approved = false): AppStudioDeliveryBlueprintRevision {
    const next = this.db.prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM app_studio_delivery_blueprints WHERE app_session_id = ?').get(sessionId) as { n: number };
    if (approved) this.db.prepare("UPDATE app_studio_delivery_blueprints SET status = 'superseded' WHERE app_session_id = ? AND status = 'approved'").run(sessionId);
    const info = this.db.prepare(`INSERT INTO app_studio_delivery_blueprints
      (app_session_id, revision_number, status, blueprint_json, approved_at) VALUES (?, ?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END)`)
      .run(sessionId, next.n, approved ? 'approved' : 'draft', blueprintJson, approved ? 1 : 0);
    const revision = this.db.prepare('SELECT * FROM app_studio_delivery_blueprints WHERE id = ?').get(Number(info.lastInsertRowid)) as AppStudioDeliveryBlueprintRevision;
    this.appendWorkflowEvent(sessionId, 'blueprint.saved', 'delivery_blueprint', String(revision.id), JSON.stringify({ revision: revision.revision_number }));
    return revision;
  }

  approveBlueprintArtifacts(sessionId: number): void {
    const tx = this.db.transaction(() => {
      const approveLatest = (table: string) => {
        const row = this.db.prepare(`SELECT id FROM ${table} WHERE app_session_id = ? AND status <> 'rejected' ORDER BY revision_number DESC LIMIT 1`).get(sessionId) as { id: number } | undefined;
        if (!row) return;
        this.db.prepare(`UPDATE ${table} SET status = 'superseded' WHERE app_session_id = ? AND id <> ? AND status = 'approved'`).run(sessionId, row.id);
        this.db.prepare(`UPDATE ${table} SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(row.id);
      };
      approveLatest('app_studio_architecture_revisions');
      approveLatest('app_studio_ux_revisions');
      approveLatest('app_studio_wireframe_revisions');
      const blueprint = this.db.prepare("SELECT id FROM app_studio_delivery_blueprints WHERE app_session_id = ? AND status <> 'superseded' ORDER BY revision_number DESC LIMIT 1").get(sessionId) as { id: number } | undefined;
      if (blueprint) {
        this.db.prepare("UPDATE app_studio_delivery_blueprints SET status = 'superseded' WHERE app_session_id = ? AND id <> ? AND status = 'approved'").run(sessionId, blueprint.id);
        this.db.prepare("UPDATE app_studio_delivery_blueprints SET status = 'approved', approved_at = datetime('now') WHERE id = ?").run(blueprint.id);
      }
    });
    tx();
  }

  appendWorkflowEvent(sessionId: number, kind: string, entityType: string, entityId: string, payloadJson = '{}', idempotencyKey?: string | null): AppStudioWorkflowEvent {
    this.db.prepare(`INSERT OR IGNORE INTO app_studio_workflow_events
      (app_session_id, kind, entity_type, entity_id, payload_json, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, kind, entityType, entityId, payloadJson, idempotencyKey ?? null);
    if (idempotencyKey) {
      return this.db.prepare('SELECT * FROM app_studio_workflow_events WHERE app_session_id = ? AND idempotency_key = ?').get(sessionId, idempotencyKey) as AppStudioWorkflowEvent;
    }
    return this.db.prepare('SELECT * FROM app_studio_workflow_events WHERE id = last_insert_rowid()').get() as AppStudioWorkflowEvent;
  }

  listWorkflowEvents(sessionId: number, afterId = 0): AppStudioWorkflowEvent[] {
    return this.db.prepare('SELECT * FROM app_studio_workflow_events WHERE app_session_id = ? AND id > ? ORDER BY id LIMIT 250')
      .all(sessionId, afterId) as AppStudioWorkflowEvent[];
  }

  applyWorkflowMigration(input: {
    sessionId: number; sourceVersion: number; previousStateJson: string | null; workflowJson: string;
    workItems: UpsertAppStudioWorkItemInput[];
    approvals: Array<{ type: AppStudioApprovalType; status: AppStudioApprovalStatus; bundleRevision: number; bundleJson: string; summary: string; feedback?: string | null }>;
    blueprintJson?: string | null;
  }): AppStudioSession {
    const tx = this.db.transaction(() => {
      const current = this.getSession(input.sessionId);
      if (!current) throw new Error(`App session ${input.sessionId} not found.`);
      try {
        const parsed = current.pipeline_json ? JSON.parse(current.pipeline_json) as { v?: number } : null;
        if (parsed?.v === 5) return current;
      } catch { /* snapshot and replace invalid legacy state */ }
      this.db.prepare(`INSERT INTO app_studio_workflow_snapshots
        (app_session_id, source_version, pipeline_json, workflow_json) VALUES (?, ?, ?, ?)`)
        .run(input.sessionId, input.sourceVersion, input.previousStateJson, input.workflowJson);
      this.db.prepare('UPDATE app_studio_sessions SET pipeline_json = ? WHERE id = ?').run(input.workflowJson, input.sessionId);
      this.upsertWorkItems(input.workItems);
      for (const approval of input.approvals) {
        this.db.prepare(`INSERT OR IGNORE INTO app_studio_approvals
          (app_session_id, type, status, bundle_revision, bundle_json, summary, feedback, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'approved' THEN datetime('now') ELSE NULL END)`)
          .run(input.sessionId, approval.type, approval.status, approval.bundleRevision, approval.bundleJson, approval.summary, approval.feedback ?? null, approval.status);
      }
      if (input.blueprintJson) this.saveDeliveryBlueprint(input.sessionId, input.blueprintJson, true);
      this.appendWorkflowEvent(input.sessionId, 'workflow.migrated', 'workflow', String(input.sessionId), JSON.stringify({ from: input.sourceVersion, to: 5 }), `workflow-migration-v5:${input.sessionId}`);
      return this.getSession(input.sessionId)!;
    });
    return tx();
  }

  /** One-shot compatibility reader; new progress lives only in work items. */
  readLegacyFeatureNames(sessionId: number): string[] {
    return (this.db.prepare('SELECT name FROM app_studio_features WHERE app_session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ name: string }>).map((row) => row.name);
  }
}
