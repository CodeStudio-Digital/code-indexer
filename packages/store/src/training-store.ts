/**
 * TrainingStore — CRUD over the local fine-tuning tables introduced by
 * migration 121 (`training_datasets`, `training_examples`, `training_runs`).
 *
 * Thin facade over the pure functions in `./db/training.js`, constructed from
 * a raw better-sqlite3 handle (`CodeIndexDB.raw()`) — same convention as
 * `DocStore`. Lets the training service layer talk to the DB without touching
 * the legacy `CodeIndexDB` god-class.
 */
import type DatabaseConstructor from 'better-sqlite3';
import * as t from './db/training.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export type {
  DatasetStatus,
  RunStatus,
  Verdict,
  TrainingDataset,
  TrainingExample,
  TrainingRun,
  NewDataset,
  NewExample,
  FinishDatasetData,
  RunProgress,
  FinishRunData,
} from './db/training.js';

export class TrainingStore {
  constructor(private db: DB) {}

  createDataset(d: t.NewDataset): number { return t.createDataset(this.db, d); }
  getDataset(id: number): t.TrainingDataset | undefined { return t.getDataset(this.db, id); }
  listDatasets(projectId: number, limit?: number): t.TrainingDataset[] {
    return t.listDatasets(this.db, projectId, limit);
  }
  addExample(e: t.NewExample): number { return t.addExample(this.db, e); }
  listExamples(datasetId: number, limit?: number): t.TrainingExample[] {
    return t.listExamples(this.db, datasetId, limit);
  }
  finishDataset(id: number, d: t.FinishDatasetData): void { t.finishDataset(this.db, id, d); }
  deleteDataset(id: number): void { t.deleteDataset(this.db, id); }

  createRun(datasetId: number, baseModel: string): number {
    return t.createTrainingRun(this.db, datasetId, baseModel);
  }
  updateRunProgress(runId: number, p: t.RunProgress): void {
    t.updateRunProgress(this.db, runId, p);
  }
  finishRun(runId: number, d: t.FinishRunData): void { t.finishRun(this.db, runId, d); }
  getRun(id: number): t.TrainingRun | undefined { return t.getRun(this.db, id); }
  listRuns(datasetId: number, limit?: number): t.TrainingRun[] {
    return t.listRuns(this.db, datasetId, limit);
  }
}
