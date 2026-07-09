/**
 * Migration 200 — App Studio ("Code Studio para leigos", v0-style full
 * Cloudflare).
 *
 *   - app_studio_sessions → 1 por projeto (UNIQUE project_id). Config
 *     imutável fixada no scaffold (app_slug = worker name, stack,
 *     db_engine) + os documentos vivos da jornada:
 *       spec_json      → AppSpec aprovada na entrevista (schema versionado
 *                        em @mcp/app-studio/spec/types.ts); trava quando a
 *                        etapa discovery é aprovada.
 *       pipeline_json  → máquina de 6 etapas (discovery→database→design→
 *                        backend→review→launch), schema em
 *                        @mcp/app-studio/pipeline/stages.ts. `current_stage`
 *                        é DERIVADO (primeira não aprovada/pulada), nunca
 *                        armazenado — armazenar duplicaria e driftaria.
 *       interview_json → pergunta pendente + opções (tool app_interview_ask)
 *                        que a UI renderiza como chips de resposta rápida.
 *       deploy_json    → estado do deploy na conta CF do usuário
 *                        ({account, database_id, url, health_ok, …}),
 *                        escrito pela launch chain server-side.
 *
 *   - app_studio_features → deliverables registrados pelo agente via
 *     app_record_feature (kind 'screen' | 'api' | 'feature'); o progresso
 *     do roadmap deriva por name-match tier-aware, nunca é armazenado.
 *
 * db_engine já aceita postgres/mysql no CHECK (fase 2 via Podman) — o MVP
 * só cria 'd1'. Idempotente (CREATE TABLE IF NOT EXISTS); FK cascade só
 * dispara com PRAGMA foreign_keys ON, então o store também deleta filhos
 * explicitamente (mesmo caveat das migrations 174/196).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const appStudio200: Migration = {
  version: 200,
  name: 'app_studio',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_studio_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        app_slug TEXT NOT NULL,
        stack TEXT NOT NULL DEFAULT 'cf-fullstack' CHECK(stack IN ('cf-fullstack')),
        db_engine TEXT NOT NULL DEFAULT 'd1' CHECK(db_engine IN ('d1','postgres','mysql')),
        spec_json TEXT,
        pipeline_json TEXT,
        interview_json TEXT,
        deploy_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS app_studio_features (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('screen','api','feature')),
        summary TEXT,
        verified_in_preview INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(app_session_id, name, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_app_studio_features_session
        ON app_studio_features(app_session_id);
    `);
  },
};
