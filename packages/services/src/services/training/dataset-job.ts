/**
 * Dataset job — orchestrates Phase A end-to-end:
 *   seeds (indexer) → grounding (RAG, injected) → teacher → validator gate →
 *   persist example + append JSONL → finalize.
 *
 * Decoupled from transport: progress is reported via an `onProgress` callback
 * (same shape as the indexer's stream), so the worker layer can pump it to SSE
 * while tests can assert on it directly. RAG grounding and the visual gate are
 * injected so this module stays free of the DocSearch/MCP wiring.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { TrainingStore } from '@mcp/store/training-store.js';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { getProfile } from './stack-profiles.js';
import { extractSeeds } from './seed-extractor.js';
import { listProjectFileSeeds } from './seed-files.js';
import { buildTeacherMessages } from './teacher-prompt.js';
import { TeacherClient } from './teacher-client.js';
import { validateOutput } from './validator.js';
import { JsonlWriter, datasetPaths } from './jsonl-export.js';
import type { DatasetJobConfig, Seed, ValidationResult } from './types.js';

export interface DatasetProgress {
  event: 'start' | 'example' | 'done' | 'error' | 'status';
  datasetId: number;
  index?: number;
  total?: number;
  verdict?: 'pass' | 'fail';
  accepted?: number;
  costUsd?: number;
  message?: string;
}

export interface DatasetJobDeps {
  db: CodeIndexDB;
  store: TrainingStore;
  shell: IShellPort;
  dataDir: string;
  grounding?: (query: string, collection: string) => Promise<string[]>;
  /** Live golden-example seeds (e.g. shadcn blocks via MCP). Supplements
   *  project seeds and carries generation when the index is empty. */
  blockSeeds?: (limit: number) => Promise<Seed[]>;
  visualGate?: (sandboxDir: string) => Promise<ValidationResult>;
  onProgress?: (p: DatasetProgress) => void;
  signal?: AbortSignal;
}

export interface DatasetJobResult {
  datasetId: number;
  accepted: number;
  total: number;
  costUsd: number;
}

export async function runDatasetJob(
  config: DatasetJobConfig,
  deps: DatasetJobDeps,
): Promise<DatasetJobResult> {
  const profile = getProfile(config.stackProfileId);
  const holdoutEvery = Math.max(2, Math.round(1 / (config.holdoutRatio ?? 0.1)));

  const datasetId = deps.store.createDataset({
    projectId: config.projectId,
    name: config.name,
    stackProfile: profile.id,
    teacherProvider: config.teacherProvider,
    teacherModel: config.teacherModel,
    docCollection: config.docCollection,
    targetCount: config.targetCount,
  });
  const emit = (p: Omit<DatasetProgress, 'datasetId'>): void =>
    deps.onProgress?.({ datasetId, ...p });

  const paths = datasetPaths(deps.dataDir, datasetId);
  const writer = new JsonlWriter(paths);

  try {
    // Multi-source seed pipeline, ordered, filling to targetCount:
    //   1) indexed code (files table)  2) raw project files on disk (no index)
    //   3) shadcn blocks via the user's MCP server (golden examples).
    const seeds = await extractSeeds(
      deps.db, config.projectId, config.projectRoot, profile, config.targetCount,
    );
    if (seeds.length < config.targetCount) {
      try {
        const fs = await listProjectFileSeeds(
          config.projectRoot, profile, config.targetCount - seeds.length,
        );
        seeds.push(...fs);
      } catch { /* unreadable project root — skip FS source */ }
    }
    if (seeds.length < config.targetCount && deps.blockSeeds) {
      try {
        const extra = await deps.blockSeeds(config.targetCount - seeds.length);
        seeds.push(...extra);
      } catch { /* MCP unavailable — fall back to project seeds only */ }
    }
    // Emit the REAL work size (seed count) so the UI never sits silently at
    // zero — an empty index / no matching files is the common gotcha.
    emit({ event: 'start', total: seeds.length });
    if (seeds.length === 0) {
      deps.store.finishDataset(datasetId, {
        status: 'done', costUsd: 0, jsonlPath: paths.trainPath, holdoutPath: paths.holdoutPath,
        statusMessage: 'no_seeds',
      });
      emit({ event: 'done', accepted: 0, total: 0, costUsd: 0, message: 'no_seeds' });
      return { datasetId, accepted: 0, total: 0, costUsd: 0 };
    }
    const teacher = await TeacherClient.create(config.teacherProvider, config.teacherModel);

    let accepted = 0;
    let costUsd = 0;
    for (let i = 0; i < seeds.length; i++) {
      if (deps.signal?.aborted) break;
      const seed = seeds[i];
      const grounding = config.docCollection && deps.grounding
        ? await deps.grounding(seed.name, config.docCollection)
        : [];
      const { system, messages } = buildTeacherMessages(profile, seed, grounding);

      let verdict: 'pass' | 'fail' = 'fail';
      let log = '';
      try {
        const ex = await teacher.generateExample(system, messages, deps.signal);
        costUsd += ex.costUsd;
        const result = await validateOutput(
          profile, ex.output,
          {
            shell: deps.shell, dataDir: deps.dataDir, visualGate: deps.visualGate,
            onStatus: (message) => emit({ event: 'status', message }),
          },
          deps.signal,
        );
        verdict = result.verdict;
        log = result.log;
        const isHoldout = verdict === 'pass' && accepted % holdoutEvery === holdoutEvery - 1;
        deps.store.addExample({
          datasetId, instruction: ex.instruction, input: ex.input, output: ex.output,
          seedLabel: seed.filePath, verdict, validationLog: log, isHoldout,
        });
        if (verdict === 'pass') { await writer.append(ex, isHoldout); accepted++; }
      } catch (e) {
        log = e instanceof Error ? e.message : String(e);
        deps.store.addExample({
          datasetId, instruction: '(generation failed)', output: '', seedLabel: seed.filePath,
          verdict: 'fail', validationLog: log,
        });
      }
      emit({ event: 'example', index: i, total: seeds.length, verdict, accepted, costUsd });
    }

    deps.store.finishDataset(datasetId, {
      status: 'done', costUsd, jsonlPath: paths.trainPath, holdoutPath: paths.holdoutPath,
    });
    emit({ event: 'done', accepted, total: seeds.length, costUsd });
    return { datasetId, accepted, total: seeds.length, costUsd };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.store.finishDataset(datasetId, { status: 'error', costUsd: 0, statusMessage: message });
    emit({ event: 'error', message });
    throw e;
  }
}
