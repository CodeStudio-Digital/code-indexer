/**
 * DAO for the local fine-tuning corpus (migration 121).
 *
 * Pure functions over a raw better-sqlite3 handle — obtained via
 * `CodeIndexDB.raw()` — mirroring the style of `db/runs.ts`. The training
 * service layer owns the orchestration; this module only persists.
 */
import type { DB } from './types.js';

export type DatasetStatus = 'pending' | 'running' | 'done' | 'error';
export type RunStatus =
  | 'pending' | 'training' | 'exporting' | 'serving' | 'done' | 'error';
export type Verdict = 'pass' | 'fail';

export interface TrainingDataset {
  id: number;
  project_id: number;
  name: string;
  stack_profile: string;
  teacher_provider: string | null;
  teacher_model: string | null;
  doc_collection: string | null;
  status: DatasetStatus;
  status_message: string | null;
  target_count: number;
  example_count: number;
  accepted_count: number;
  rejected_count: number;
  cost_usd: number;
  jsonl_path: string | null;
  holdout_path: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TrainingExample {
  id: number;
  dataset_id: number;
  instruction: string;
  input: string | null;
  output: string;
  seed_symbol_id: number | null;
  seed_label: string | null;
  verdict: Verdict;
  validation_log: string | null;
  is_holdout: number;
  created_at: string;
}

export interface TrainingRun {
  id: number;
  dataset_id: number;
  base_model: string;
  status: RunStatus;
  status_message: string | null;
  step: number;
  total_steps: number;
  loss: number | null;
  vram_mb: number | null;
  adapter_path: string | null;
  gguf_path: string | null;
  ollama_model: string | null;
  baseline_score: number | null;
  trained_score: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface NewDataset {
  projectId: number;
  name: string;
  stackProfile: string;
  teacherProvider?: string;
  teacherModel?: string;
  docCollection?: string;
  targetCount: number;
}

export interface NewExample {
  datasetId: number;
  instruction: string;
  input?: string;
  output: string;
  seedSymbolId?: number;
  seedLabel?: string;
  verdict: Verdict;
  validationLog?: string;
  isHoldout?: boolean;
}

// ─── Datasets ───────────────────────────────────────────────────────

export function createDataset(db: DB, d: NewDataset): number {
  const r = db.prepare(`
    INSERT INTO training_datasets
      (project_id, name, stack_profile, teacher_provider, teacher_model,
       doc_collection, target_count, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
  `).run(
    d.projectId, d.name, d.stackProfile, d.teacherProvider ?? null,
    d.teacherModel ?? null, d.docCollection ?? null, d.targetCount,
  );
  return r.lastInsertRowid as number;
}

export function getDataset(db: DB, id: number): TrainingDataset | undefined {
  return db.prepare('SELECT * FROM training_datasets WHERE id = ?')
    .get(id) as TrainingDataset | undefined;
}

export function listDatasets(db: DB, projectId: number, limit = 50): TrainingDataset[] {
  return db.prepare(
    'SELECT * FROM training_datasets WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(projectId, limit) as TrainingDataset[];
}

export function deleteDataset(db: DB, id: number): void {
  // FK ON DELETE CASCADE removes training_examples + training_runs.
  db.prepare('DELETE FROM training_datasets WHERE id = ?').run(id);
}

export function addExample(db: DB, e: NewExample): number {
  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO training_examples
        (dataset_id, instruction, input, output, seed_symbol_id, seed_label,
         verdict, validation_log, is_holdout)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.datasetId, e.instruction, e.input ?? null, e.output,
      e.seedSymbolId ?? null, e.seedLabel ?? null, e.verdict,
      e.validationLog ?? null, e.isHoldout ? 1 : 0,
    );
    const acc = e.verdict === 'pass' ? 1 : 0;
    db.prepare(`
      UPDATE training_datasets
        SET example_count = example_count + 1,
            accepted_count = accepted_count + ?,
            rejected_count = rejected_count + ?
      WHERE id = ?
    `).run(acc, 1 - acc, e.datasetId);
    return r.lastInsertRowid as number;
  });
  return tx();
}

export interface FinishDatasetData {
  status: DatasetStatus;
  costUsd: number;
  jsonlPath?: string;
  holdoutPath?: string;
  statusMessage?: string;
}

export function finishDataset(db: DB, id: number, d: FinishDatasetData): void {
  db.prepare(`
    UPDATE training_datasets
      SET status = ?, cost_usd = ?, jsonl_path = ?, holdout_path = ?,
          status_message = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(d.status, d.costUsd, d.jsonlPath ?? null, d.holdoutPath ?? null,
    d.statusMessage ?? null, id);
}

// ─── Runs ───────────────────────────────────────────────────────────

export function listExamples(db: DB, datasetId: number, limit = 50): TrainingExample[] {
  return db.prepare(
    'SELECT * FROM training_examples WHERE dataset_id = ? ORDER BY id DESC LIMIT ?',
  ).all(datasetId, limit) as TrainingExample[];
}

export function createTrainingRun(db: DB, datasetId: number, baseModel: string): number {
  const r = db.prepare(`
    INSERT INTO training_runs (dataset_id, base_model, status)
    VALUES (?, ?, 'pending')
  `).run(datasetId, baseModel);
  return r.lastInsertRowid as number;
}

export interface RunProgress {
  step?: number;
  totalSteps?: number;
  loss?: number;
  vramMb?: number;
  status?: RunStatus;
  statusMessage?: string;
}

export function updateRunProgress(db: DB, runId: number, p: RunProgress): void {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  const put = (col: string, v: string | number | undefined): void => {
    if (v === undefined) return;
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  put('step', p.step);
  put('total_steps', p.totalSteps);
  put('loss', p.loss);
  put('vram_mb', p.vramMb);
  put('status', p.status);
  put('status_message', p.statusMessage);
  if (sets.length === 0) return;
  vals.push(runId);
  db.prepare(`UPDATE training_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export interface FinishRunData {
  status: RunStatus;
  adapterPath?: string;
  ggufPath?: string;
  ollamaModel?: string;
  baselineScore?: number;
  trainedScore?: number;
  statusMessage?: string;
}

export function finishRun(db: DB, runId: number, d: FinishRunData): void {
  db.prepare(`
    UPDATE training_runs
      SET status = ?, adapter_path = COALESCE(?, adapter_path),
          gguf_path = COALESCE(?, gguf_path), ollama_model = COALESCE(?, ollama_model),
          baseline_score = COALESCE(?, baseline_score),
          trained_score = COALESCE(?, trained_score),
          status_message = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(d.status, d.adapterPath ?? null, d.ggufPath ?? null, d.ollamaModel ?? null,
    d.baselineScore ?? null, d.trainedScore ?? null, d.statusMessage ?? null, runId);
}

export function getRun(db: DB, id: number): TrainingRun | undefined {
  return db.prepare('SELECT * FROM training_runs WHERE id = ?')
    .get(id) as TrainingRun | undefined;
}

export function listRuns(db: DB, datasetId: number, limit = 50): TrainingRun[] {
  return db.prepare(
    'SELECT * FROM training_runs WHERE dataset_id = ? ORDER BY started_at DESC LIMIT ?',
  ).all(datasetId, limit) as TrainingRun[];
}
