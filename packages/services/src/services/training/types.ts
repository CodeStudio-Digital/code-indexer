/**
 * Shared types for the local fine-tuning dataset pipeline (Phase A).
 *
 * The flow: `Seed` (real code/example) → teacher produces a `GeneratedExample`
 * → `validator` returns a `ValidationResult` → accepted examples are exported
 * to JSONL. `EvalResult` is the objective "did Phase A pay off" signal,
 * measured by the eval-harness on a held-out slice.
 */

export type Verdict = 'pass' | 'fail';

/** A real code snippet used to ground the teacher's example generation. */
export interface Seed {
  /** symbols.id when sourced from the project index; undefined for external. */
  symbolId?: number;
  name: string;
  filePath: string;
  body: string;
  kind: string;
  /** where the seed came from — drives prompt framing. */
  source: 'project' | 'shadcn-block';
}

/** One instruction/input/output triple emitted by the teacher provider. */
export interface GeneratedExample {
  instruction: string;
  input: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ValidationResult {
  verdict: Verdict;
  /** Combined stdout/stderr of the validator commands (truncated). */
  log: string;
}

export interface DatasetJobConfig {
  projectId: number;
  /** project root on disk — where the indexer ran; used for validation context. */
  projectRoot: string;
  name: string;
  stackProfileId: string;
  teacherProvider?: string;
  teacherModel?: string;
  docCollection?: string;
  targetCount: number;
  /** fraction reserved for the eval-harness holdout. Default 0.1. */
  holdoutRatio?: number;
  /** run the optional Vite render + screenshot visual gate. Default false. */
  visualGate?: boolean;
}

export interface EvalResult {
  total: number;
  passed: number;
  /** passed / total, 0..1. */
  passRate: number;
}
