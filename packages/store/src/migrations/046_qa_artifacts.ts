/**
 * Migration 046 — QA artefatos: service scoping + paths de evidência.
 *
 * Adiciona `service_id` ao `qa_test_runs` para que sessões multi-microservice
 * (frontend + api + worker no mesmo company session) possam ter runs
 * indexadas por qual container rodou os testes. Backfill default = 'main'
 * preserva runs existentes (sessão 68 era single-service).
 *
 * Adiciona `screenshot_path` e `video_path` ao `qa_test_results` para que
 * o reporter custom catalogue essas evidências via `result.attachments`
 * (Playwright já produz quando `screenshot:'only-on-failure'` e
 * `video:'retain-on-failure'` no config — defaults nossos). O endpoint
 * `/qa/artifact` resolve o caminho ao servir.
 *
 * Index `idx_qa_runs_session_service` cobre o caso comum do dashboard
 * "lista runs daquele service ordenadas por data".
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const qaArtifacts046 = {
  version: 46,
  name: 'qa_artifacts',
  up(db: DB) {
    db.exec(`
      ALTER TABLE qa_test_runs ADD COLUMN service_id TEXT NOT NULL DEFAULT 'main';
      ALTER TABLE qa_test_results ADD COLUMN screenshot_path TEXT;
      ALTER TABLE qa_test_results ADD COLUMN video_path TEXT;

      CREATE INDEX idx_qa_runs_session_service
        ON qa_test_runs(company_session_id, service_id, started_at DESC);
    `);
  },
};
