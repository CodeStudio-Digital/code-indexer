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
    this.db.prepare('DELETE FROM app_studio_features WHERE app_session_id = ?').run(id);
    this.db.prepare('DELETE FROM app_studio_sessions WHERE id = ?').run(id);
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
}
