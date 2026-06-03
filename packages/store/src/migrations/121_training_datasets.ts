/**
 * Migration 121 — Local fine-tuning corpus (distillation datasets + runs).
 *
 * Backs the "Treino" feature: a teacher LLM (an already-configured provider)
 * generates instruction/input/output triples grounded on the project's indexer
 * + RAG docs; each candidate is gated through a stack-specific validator
 * (tsc/eslint/vite build / pytest / go test …) before it joins the dataset.
 * The accepted examples are exported to JSONL and used to QLoRA-train a small
 * coder model, which can then be served locally via Ollama.
 *
 *   1. `training_datasets`  — one row per generated corpus (stack profile,
 *                             teacher provider, counts, JSONL paths).
 *   2. `training_examples`  — every candidate the teacher produced, with its
 *                             validator verdict; ~10% flagged `is_holdout` for
 *                             the eval-harness baseline/after comparison.
 *   3. `training_runs`      — one row per QLoRA run over a dataset (selected
 *                             base model, live step/loss, adapter/gguf paths,
 *                             baseline→trained eval scores). Included here so
 *                             Phase B needs no extra migration.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const trainingDatasets121: Migration = {
  version: 121,
  name: 'training_datasets',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS training_datasets (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id       INTEGER NOT NULL,
        name             TEXT NOT NULL,
        stack_profile    TEXT NOT NULL,
        teacher_provider TEXT,
        teacher_model    TEXT,
        doc_collection   TEXT,
        status           TEXT NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending','running','done','error')),
        status_message   TEXT,
        target_count     INTEGER NOT NULL DEFAULT 0,
        example_count    INTEGER NOT NULL DEFAULT 0,
        accepted_count   INTEGER NOT NULL DEFAULT 0,
        rejected_count   INTEGER NOT NULL DEFAULT 0,
        cost_usd         REAL NOT NULL DEFAULT 0,
        jsonl_path       TEXT,
        holdout_path     TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_training_datasets_project
        ON training_datasets(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_training_datasets_status
        ON training_datasets(status);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS training_examples (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id      INTEGER NOT NULL REFERENCES training_datasets(id) ON DELETE CASCADE,
        instruction     TEXT NOT NULL,
        input           TEXT,
        output          TEXT NOT NULL,
        seed_symbol_id  INTEGER,
        seed_label      TEXT,
        verdict         TEXT NOT NULL CHECK(verdict IN ('pass','fail')),
        validation_log  TEXT,
        is_holdout      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_training_examples_dataset
        ON training_examples(dataset_id, verdict);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS training_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id      INTEGER NOT NULL REFERENCES training_datasets(id) ON DELETE CASCADE,
        base_model      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','training','exporting','serving','done','error')),
        status_message  TEXT,
        step            INTEGER NOT NULL DEFAULT 0,
        total_steps     INTEGER NOT NULL DEFAULT 0,
        loss            REAL,
        vram_mb         INTEGER,
        adapter_path    TEXT,
        gguf_path       TEXT,
        ollama_model    TEXT,
        baseline_score  REAL,
        trained_score   REAL,
        started_at      TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_training_runs_dataset
        ON training_runs(dataset_id, started_at);
    `);
  },
};
