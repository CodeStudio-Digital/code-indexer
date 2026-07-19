/** App Studio v6 canonical control-plane store. */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { AppFitnessReport, AppPlanRevisionStatus, AppPlanV1 } from '@mcp/app-studio/plan/types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type AppStudioWorkItemStatus = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'blocked' | 'stale' | 'cancelled';
export type AppStudioWorkItemKind = 'research' | 'plan' | 'contract' | 'implement' | 'verify' | 'release' | 'change';
export type AppStudioWorkItemRunStatus = 'claimed' | 'running' | 'waiting' | 'paused' | 'completed' | 'blocked' | 'error' | 'aborted' | 'interrupted' | 'cancelled';

export interface AppStudioSession {
  id: number;
  project_id: number;
  company_session_id: number | null;
  name: string;
  app_slug: string;
  stack_profile_id: 'cf-fullstack-v1';
  created_at: string;
  updated_at: string;
}

export interface CreateAppStudioSessionInput {
  project_id: number;
  name: string;
  app_slug: string;
}

export interface AppStudioPlanRevision {
  id: number;
  app_session_id: number;
  revision_number: number;
  status: AppPlanRevisionStatus;
  plan_json: string;
  fitness_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

export interface SaveAppStudioPlanRevisionInput {
  app_session_id: number;
  plan: AppPlanV1;
  fitness: AppFitnessReport;
  created_by?: string;
  expected_revision_number?: number | null;
}

export interface AppStudioWorkItem {
  app_session_id: number;
  id: string;
  plan_revision_id: number;
  slice_id: string | null;
  title: string;
  outcome: string;
  kind: AppStudioWorkItemKind;
  owner_role: string;
  priority: number;
  status: AppStudioWorkItemStatus;
  sort_order: number;
  depends_on_json: string;
  source_ids_json: string;
  acceptance_json: string;
  evidence_json: string;
  file_scope_json: string;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertAppStudioWorkItemInput {
  app_session_id: number;
  id: string;
  plan_revision_id: number;
  slice_id?: string | null;
  title: string;
  outcome?: string;
  kind: AppStudioWorkItemKind;
  owner_role: string;
  priority?: number;
  status?: AppStudioWorkItemStatus;
  sort_order?: number;
  depends_on_json?: string;
  source_ids_json?: string;
  acceptance_json?: string;
  evidence_json?: string;
  file_scope_json?: string;
  blocked_reason?: string | null;
}

export interface AppStudioWorkItemRun {
  id: number;
  app_session_id: number;
  work_item_id: string;
  attempt: number;
  role: string;
  company_agent_run_id: number | null;
  coder_session_id: number | null;
  status: AppStudioWorkItemRunStatus;
  runtime_config_hash: string | null;
  idempotency_key: string;
  status_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface CreateAppStudioWorkItemRunInput {
  appSessionId: number;
  workItemId: string;
  attempt: number;
  role: string;
  companyAgentRunId?: number | null;
  coderSessionId?: number | null;
  status?: AppStudioWorkItemRunStatus;
  runtimeConfigHash?: string | null;
  idempotencyKey?: string;
}

export interface UpdateAppStudioWorkItemRunOptions {
  companyAgentRunId?: number | null;
  coderSessionId?: number | null;
  runtimeConfigHash?: string | null;
  statusMessage?: string | null;
}

export interface AppStudioDecision {
  id: number;
  app_session_id: number;
  plan_revision_id: number;
  question: string;
  options_json: string;
  blocked_work_item_ids_json: string;
  status: 'open' | 'resolved';
  answer: string | null;
  requested_at: string;
  resolved_at: string | null;
}

export interface AppStudioEvent {
  id: number;
  app_session_id: number;
  kind: string;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  idempotency_key: string | null;
  created_at: string;
}

export interface AppStudioDeployment {
  id: number;
  app_session_id: number;
  plan_revision_id: number;
  status: 'publishing' | 'live' | 'failed';
  url: string | null;
  account: string | null;
  database_id: string | null;
  health_ok: number;
  details_json: string;
  created_at: string;
  updated_at: string;
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

  close(): void { if (this.ownsConnection) this.db.close(); }

  createSession(input: CreateAppStudioSessionInput): AppStudioSession {
    const info = this.db.prepare(`
      INSERT INTO app_studio_sessions (project_id, name, app_slug)
      VALUES (?, ?, ?)
    `).run(input.project_id, input.name, input.app_slug);
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  getSession(id: number): AppStudioSession | null {
    return (this.db.prepare('SELECT * FROM app_studio_sessions WHERE id = ?').get(id) as AppStudioSession | undefined) ?? null;
  }

  getSessionByProjectId(projectId: number): AppStudioSession | null {
    return (this.db.prepare('SELECT * FROM app_studio_sessions WHERE project_id = ?').get(projectId) as AppStudioSession | undefined) ?? null;
  }

  getSessionByCompanySessionId(companySessionId: number): AppStudioSession | null {
    return (this.db.prepare('SELECT * FROM app_studio_sessions WHERE company_session_id = ?').get(companySessionId) as AppStudioSession | undefined) ?? null;
  }

  listSessions(): AppStudioSession[] {
    return this.db.prepare('SELECT * FROM app_studio_sessions ORDER BY updated_at DESC, id DESC').all() as AppStudioSession[];
  }

  setCompanySessionId(id: number, companySessionId: number): AppStudioSession {
    this.db.prepare("UPDATE app_studio_sessions SET company_session_id = ?, updated_at = datetime('now') WHERE id = ?").run(companySessionId, id);
    const session = this.getSession(id);
    if (!session) throw new Error(`App Studio session ${id} not found`);
    return session;
  }

  deleteSession(id: number): void {
    this.db.prepare('DELETE FROM app_studio_sessions WHERE id = ?').run(id);
  }

  listPlanRevisions(sessionId: number): AppStudioPlanRevision[] {
    return this.db.prepare('SELECT * FROM app_studio_plan_revisions WHERE app_session_id = ? ORDER BY revision_number DESC').all(sessionId) as AppStudioPlanRevision[];
  }

  getPlanRevision(id: number): AppStudioPlanRevision | null {
    return (this.db.prepare('SELECT * FROM app_studio_plan_revisions WHERE id = ?').get(id) as AppStudioPlanRevision | undefined) ?? null;
  }

  getLatestPlanRevision(sessionId: number): AppStudioPlanRevision | null {
    return (this.db.prepare('SELECT * FROM app_studio_plan_revisions WHERE app_session_id = ? ORDER BY revision_number DESC LIMIT 1').get(sessionId) as AppStudioPlanRevision | undefined) ?? null;
  }

  getLatestApprovedPlanRevision(sessionId: number): AppStudioPlanRevision | null {
    return (this.db.prepare("SELECT * FROM app_studio_plan_revisions WHERE app_session_id = ? AND status = 'approved' ORDER BY revision_number DESC LIMIT 1").get(sessionId) as AppStudioPlanRevision | undefined) ?? null;
  }

  savePlanRevision(input: SaveAppStudioPlanRevisionInput): AppStudioPlanRevision {
    const tx = this.db.transaction(() => {
      const latest = this.getLatestPlanRevision(input.app_session_id);
      if (input.expected_revision_number !== undefined && input.expected_revision_number !== null
        && latest?.revision_number !== input.expected_revision_number) {
        throw new Error(`App plan changed (expected r${input.expected_revision_number}, current r${latest?.revision_number ?? 0})`);
      }
      this.db.prepare("UPDATE app_studio_plan_revisions SET status = 'superseded', updated_at = datetime('now') WHERE app_session_id = ? AND status = 'draft'").run(input.app_session_id);
      const next = (latest?.revision_number ?? 0) + 1;
      const info = this.db.prepare(`
        INSERT INTO app_studio_plan_revisions
          (app_session_id, revision_number, status, plan_json, fitness_json, created_by)
        VALUES (?, ?, 'draft', ?, ?, ?)
      `).run(input.app_session_id, next, JSON.stringify(input.plan), JSON.stringify(input.fitness), input.created_by ?? 'app_orchestrator');
      this.db.prepare(`
        UPDATE app_studio_work_items
        SET status = 'stale', blocked_reason = 'The App plan changed; regenerate this card from the current revision.', updated_at = datetime('now')
        WHERE app_session_id = ? AND status NOT IN ('cancelled','stale')
      `).run(input.app_session_id);
      this.db.prepare("UPDATE app_studio_sessions SET updated_at = datetime('now') WHERE id = ?").run(input.app_session_id);
      this.appendEvent(input.app_session_id, 'plan.revised', 'plan_revision', String(info.lastInsertRowid), JSON.stringify({ revision_number: next, fitness: input.fitness.status }));
      return this.getPlanRevision(Number(info.lastInsertRowid))!;
    });
    return tx();
  }

  approvePlanRevision(sessionId: number, revisionId: number): AppStudioPlanRevision {
    const tx = this.db.transaction(() => {
      const revision = this.getPlanRevision(revisionId);
      if (!revision || revision.app_session_id !== sessionId) throw new Error('App plan revision not found');
      const fitness = JSON.parse(revision.fitness_json) as AppFitnessReport;
      if (fitness.status !== 'ready') throw new Error('Only a ready App plan can be approved');
      this.db.prepare("UPDATE app_studio_plan_revisions SET status = 'superseded', updated_at = datetime('now') WHERE app_session_id = ? AND status = 'approved'").run(sessionId);
      this.db.prepare("UPDATE app_studio_plan_revisions SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(revisionId);
      this.appendEvent(sessionId, 'plan.approved', 'plan_revision', String(revisionId), JSON.stringify({ revision_number: revision.revision_number }), `plan-approved:${revisionId}`);
      return this.getPlanRevision(revisionId)!;
    });
    return tx();
  }

  listWorkItems(sessionId: number): AppStudioWorkItem[] {
    return this.db.prepare('SELECT * FROM app_studio_work_items WHERE app_session_id = ? ORDER BY sort_order, priority DESC, id').all(sessionId) as AppStudioWorkItem[];
  }

  getWorkItem(sessionId: number, id: string): AppStudioWorkItem | null {
    return (this.db.prepare('SELECT * FROM app_studio_work_items WHERE app_session_id = ? AND id = ?').get(sessionId, id) as AppStudioWorkItem | undefined) ?? null;
  }

  upsertWorkItems(items: UpsertAppStudioWorkItemInput[]): AppStudioWorkItem[] {
    const tx = this.db.transaction(() => {
      const output: AppStudioWorkItem[] = [];
      for (const item of items) {
        this.db.prepare(`
          INSERT INTO app_studio_work_items (
            app_session_id, id, plan_revision_id, slice_id, title, outcome, kind, owner_role,
            priority, status, sort_order, depends_on_json, source_ids_json, acceptance_json,
            evidence_json, file_scope_json, blocked_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(app_session_id, id) DO UPDATE SET
            plan_revision_id = excluded.plan_revision_id,
            slice_id = excluded.slice_id,
            title = excluded.title,
            outcome = excluded.outcome,
            kind = excluded.kind,
            owner_role = excluded.owner_role,
            priority = excluded.priority,
            status = excluded.status,
            sort_order = excluded.sort_order,
            depends_on_json = excluded.depends_on_json,
            source_ids_json = excluded.source_ids_json,
            acceptance_json = excluded.acceptance_json,
            file_scope_json = excluded.file_scope_json,
            blocked_reason = excluded.blocked_reason,
            updated_at = datetime('now')
        `).run(
          item.app_session_id, item.id, item.plan_revision_id, item.slice_id ?? null, item.title,
          item.outcome ?? '', item.kind, item.owner_role, item.priority ?? 0, item.status ?? 'backlog',
          item.sort_order ?? 0, item.depends_on_json ?? '[]', item.source_ids_json ?? '[]',
          item.acceptance_json ?? '[]', item.evidence_json ?? '[]', item.file_scope_json ?? '[]',
          item.blocked_reason ?? null,
        );
        output.push(this.getWorkItem(item.app_session_id, item.id)!);
      }
      return output;
    });
    return tx();
  }

  setWorkItemStatus(sessionId: number, id: string, status: AppStudioWorkItemStatus, options: {
    blockedReason?: string | null;
    evidenceJson?: string;
  } = {}): AppStudioWorkItem {
    const current = this.getWorkItem(sessionId, id);
    if (!current) throw new Error(`App work item '${id}' not found`);
    this.db.prepare(`
      UPDATE app_studio_work_items
      SET status = ?, blocked_reason = ?, evidence_json = ?, updated_at = datetime('now')
      WHERE app_session_id = ? AND id = ?
    `).run(status, options.blockedReason === undefined ? current.blocked_reason : options.blockedReason, options.evidenceJson ?? current.evidence_json, sessionId, id);
    this.appendEvent(sessionId, 'work.status', 'work_item', id, JSON.stringify({ status, blocked_reason: options.blockedReason ?? null }));
    return this.getWorkItem(sessionId, id)!;
  }

  markWorkItemsStale(sessionId: number, ids: string[], reason: string): number {
    let changed = 0;
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const info = this.db.prepare("UPDATE app_studio_work_items SET status = 'stale', blocked_reason = ?, updated_at = datetime('now') WHERE app_session_id = ? AND id = ? AND status <> 'cancelled'").run(reason, sessionId, id);
        changed += info.changes;
      }
    });
    tx();
    return changed;
  }

  refreshReadyWorkItems(sessionId: number): AppStudioWorkItem[] {
    const approved = this.getLatestApprovedPlanRevision(sessionId);
    if (!approved) return this.listWorkItems(sessionId);
    const items = this.listWorkItems(sessionId);
    const done = new Set(items.filter((item) => item.status === 'done').map((item) => item.id));
    const review = new Set(items.filter((item) => item.status === 'review').map((item) => item.id));
    const tx = this.db.transaction(() => {
      for (const item of items) {
        if (item.plan_revision_id !== approved.id || item.status !== 'backlog') continue;
        const deps = JSON.parse(item.depends_on_json) as string[];
        const dependenciesReady = item.kind === 'verify'
          ? deps.every((id) => done.has(id) || review.has(id))
          : deps.every((id) => done.has(id));
        if (dependenciesReady) {
          this.db.prepare("UPDATE app_studio_work_items SET status = 'ready', updated_at = datetime('now') WHERE app_session_id = ? AND id = ?").run(sessionId, item.id);
        }
      }
    });
    tx();
    return this.listWorkItems(sessionId);
  }

  nextWorkItemRunAttempt(sessionId: number, workItemId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM app_studio_work_item_runs WHERE app_session_id = ? AND work_item_id = ?').get(sessionId, workItemId) as { n: number };
    return row.n;
  }

  createWorkItemRun(input: CreateAppStudioWorkItemRunInput): AppStudioWorkItemRun {
    const key = input.idempotencyKey ?? `app:${input.appSessionId}:work:${input.workItemId}:attempt:${input.attempt}`;
    this.db.prepare(`
      INSERT INTO app_studio_work_item_runs (
        app_session_id, work_item_id, attempt, role, company_agent_run_id, coder_session_id,
        status, runtime_config_hash, idempotency_key, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('running','waiting') THEN datetime('now') END)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(input.appSessionId, input.workItemId, input.attempt, input.role, input.companyAgentRunId ?? null, input.coderSessionId ?? null, input.status ?? 'claimed', input.runtimeConfigHash ?? null, key, input.status ?? 'claimed');
    return this.db.prepare('SELECT * FROM app_studio_work_item_runs WHERE idempotency_key = ?').get(key) as AppStudioWorkItemRun;
  }

  getActiveWorkItemRun(sessionId: number, workItemId: string): AppStudioWorkItemRun | null {
    return (this.db.prepare("SELECT * FROM app_studio_work_item_runs WHERE app_session_id = ? AND work_item_id = ? AND status IN ('claimed','running','waiting','paused') ORDER BY attempt DESC LIMIT 1").get(sessionId, workItemId) as AppStudioWorkItemRun | undefined) ?? null;
  }

  listWorkItemRuns(sessionId: number, options: { workItemId?: string; limit?: number } = {}): AppStudioWorkItemRun[] {
    const limit = Math.max(1, Math.min(options.limit ?? 250, 1_000));
    if (options.workItemId) return this.db.prepare('SELECT * FROM app_studio_work_item_runs WHERE app_session_id = ? AND work_item_id = ? ORDER BY attempt DESC LIMIT ?').all(sessionId, options.workItemId, limit) as AppStudioWorkItemRun[];
    return this.db.prepare('SELECT * FROM app_studio_work_item_runs WHERE app_session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit) as AppStudioWorkItemRun[];
  }

  updateWorkItemRunStatus(id: number, status: AppStudioWorkItemRunStatus, options: UpdateAppStudioWorkItemRunOptions = {}): AppStudioWorkItemRun {
    const current = this.db.prepare('SELECT * FROM app_studio_work_item_runs WHERE id = ?').get(id) as AppStudioWorkItemRun | undefined;
    if (!current) throw new Error(`App work item run ${id} not found`);
    const terminal = ['completed', 'blocked', 'error', 'aborted', 'interrupted', 'cancelled'].includes(status);
    this.db.prepare(`
      UPDATE app_studio_work_item_runs SET
        status = ?,
        company_agent_run_id = ?,
        coder_session_id = ?,
        runtime_config_hash = ?,
        status_message = ?,
        started_at = CASE WHEN ? IN ('running','waiting') THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
        completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(status, options.companyAgentRunId ?? current.company_agent_run_id, options.coderSessionId ?? current.coder_session_id, options.runtimeConfigHash ?? current.runtime_config_hash, options.statusMessage ?? current.status_message, status, terminal ? 1 : 0, id);
    return this.db.prepare('SELECT * FROM app_studio_work_item_runs WHERE id = ?').get(id) as AppStudioWorkItemRun;
  }

  listDecisions(sessionId: number): AppStudioDecision[] {
    return this.db.prepare('SELECT * FROM app_studio_decisions WHERE app_session_id = ? ORDER BY requested_at DESC, id DESC').all(sessionId) as AppStudioDecision[];
  }

  createDecision(input: { sessionId: number; planRevisionId: number; question: string; optionsJson?: string; blockedWorkItemIdsJson?: string }): AppStudioDecision {
    const info = this.db.prepare(`
      INSERT INTO app_studio_decisions (app_session_id, plan_revision_id, question, options_json, blocked_work_item_ids_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.sessionId, input.planRevisionId, input.question, input.optionsJson ?? '[]', input.blockedWorkItemIdsJson ?? '[]');
    this.appendEvent(input.sessionId, 'decision.requested', 'decision', String(info.lastInsertRowid), JSON.stringify({ question: input.question }));
    return this.db.prepare('SELECT * FROM app_studio_decisions WHERE id = ?').get(info.lastInsertRowid) as AppStudioDecision;
  }

  resolveDecision(sessionId: number, id: number, answer: string): AppStudioDecision {
    this.db.prepare("UPDATE app_studio_decisions SET status = 'resolved', answer = ?, resolved_at = datetime('now') WHERE id = ? AND app_session_id = ? AND status = 'open'").run(answer, id, sessionId);
    const decision = this.db.prepare('SELECT * FROM app_studio_decisions WHERE id = ? AND app_session_id = ?').get(id, sessionId) as AppStudioDecision | undefined;
    if (!decision) throw new Error('App decision not found');
    this.appendEvent(sessionId, 'decision.resolved', 'decision', String(id), JSON.stringify({ answer }));
    return decision;
  }

  appendEvent(sessionId: number, kind: string, entityType: string, entityId: string, payloadJson = '{}', idempotencyKey?: string | null): AppStudioEvent {
    this.db.prepare(`
      INSERT OR IGNORE INTO app_studio_events (app_session_id, kind, entity_type, entity_id, payload_json, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, kind, entityType, entityId, payloadJson, idempotencyKey ?? null);
    if (idempotencyKey) return this.db.prepare('SELECT * FROM app_studio_events WHERE app_session_id = ? AND idempotency_key = ?').get(sessionId, idempotencyKey) as AppStudioEvent;
    return this.db.prepare('SELECT * FROM app_studio_events WHERE id = last_insert_rowid()').get() as AppStudioEvent;
  }

  listEvents(sessionId: number, afterId = 0): AppStudioEvent[] {
    return this.db.prepare('SELECT * FROM app_studio_events WHERE app_session_id = ? AND id > ? ORDER BY id LIMIT 250').all(sessionId, afterId) as AppStudioEvent[];
  }

  saveDeployment(input: {
    sessionId: number;
    planRevisionId: number;
    status: AppStudioDeployment['status'];
    url?: string | null;
    account?: string | null;
    databaseId?: string | null;
    healthOk?: boolean;
    detailsJson?: string;
  }): AppStudioDeployment {
    const info = this.db.prepare(`
      INSERT INTO app_studio_deployments
        (app_session_id, plan_revision_id, status, url, account, database_id, health_ok, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.sessionId, input.planRevisionId, input.status, input.url ?? null, input.account ?? null, input.databaseId ?? null, input.healthOk ? 1 : 0, input.detailsJson ?? '{}');
    const deployment = this.db.prepare('SELECT * FROM app_studio_deployments WHERE id = ?').get(info.lastInsertRowid) as AppStudioDeployment;
    this.appendEvent(input.sessionId, `deployment.${input.status}`, 'deployment', String(deployment.id), JSON.stringify({ url: deployment.url, health_ok: !!deployment.health_ok }));
    return deployment;
  }

  getLatestDeployment(sessionId: number): AppStudioDeployment | null {
    return (this.db.prepare('SELECT * FROM app_studio_deployments WHERE app_session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as AppStudioDeployment | undefined) ?? null;
  }
}
