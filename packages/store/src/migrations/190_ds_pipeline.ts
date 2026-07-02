/**
 * Migration 190 — DS Studio design pipeline.
 *
 * `design_system_sessions.mode`: modo de design fixado na criação
 * ('fidelity' = tema anexado é fonte da verdade; 'creative' = inspiração).
 * Imutável pós-criação — o bloco de prompt do agente deriva da CÓPIA em
 * `projects.builder_json` (cache-estável); esta coluna é a fonte para
 * gates/tools/UI. Legado recebe 'creative' via DEFAULT.
 *
 * `design_system_sessions.pipeline_json`: estado da máquina de etapas
 * (stages + roadmap + resumo do theme digest), schema versionado em TS
 * (`@mcp/design-system/pipeline/stages.ts`). NULL = sessão sem pipeline
 * (pré-feature) — a UI oferece backfill via POST /pipeline/init.
 * `current_stage` é DERIVADO (primeira etapa não aprovada/pulada), nunca
 * armazenado — armazenar duplicaria o array e driftaria.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const dsPipeline190: Migration = {
  version: 190,
  name: 'ds_pipeline',
  up: (db: DB): void => {
    addColumnIfMissing(
      db,
      'design_system_sessions',
      'mode',
      "TEXT NOT NULL DEFAULT 'creative' CHECK(mode IN ('fidelity','creative'))",
    );
    addColumnIfMissing(db, 'design_system_sessions', 'pipeline_json', 'TEXT');
  },
};
