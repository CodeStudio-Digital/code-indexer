/**
 * Handlers for the `training` namespace (Phase A: dataset generation).
 * Pure over HandlerDeps; no Hono/Electron. The dataset job runs IN-PROCESS
 * here (like the indexer's stream) — the worker-thread path arrives with
 * Phase B. RAG grounding + the visual gate are left unwired for now.
 */
import {
  ApiError,
  type ApiContext,
  type AsyncStream,
  type CollectionDTO,
  type DatasetStreamEvent,
  type McpServerDTO,
  type StartDatasetInput,
  type TrainingApi,
  type TrainingDatasetDTO,
  type TrainingExampleDTO,
  type TrainingProfileDTO,
  type TrainingSettingsDTO,
} from '@mcp/api-bus';
import { TrainingStore, type TrainingDataset, type TrainingExample } from '@mcp/store/training-store.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import { AppSettingsStore } from '@mcp/store/app-settings-store.js';
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { runDatasetJob } from '@mcp/services/services/training/dataset-job.js';
import { listProfiles } from '@mcp/services/services/training/stack-profiles.js';
import { fetchShadcnBlockSeeds, type McpCall } from '@mcp/services/services/training/seed-shadcn.js';
import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import type { HandlerDeps } from '../types.js';

/** AppSettings key persisting which MCP server supplies golden block seeds.
 *  Registered in the app-settings catalog (category 'mcp'). */
export const MCP_BLOCK_SERVER_KEY = 'TRAINING_MCP_BLOCK_SERVER_ID';

function toDatasetDTO(d: TrainingDataset): TrainingDatasetDTO {
  const total = d.example_count;
  return {
    id: d.id, projectId: d.project_id, name: d.name, stackProfile: d.stack_profile,
    status: d.status, exampleCount: total, acceptedCount: d.accepted_count,
    rejectedCount: d.rejected_count, acceptanceRate: total > 0 ? d.accepted_count / total : 0,
    costUsd: d.cost_usd, jsonlPath: d.jsonl_path, createdAt: d.created_at, finishedAt: d.finished_at,
  };
}

function toExampleDTO(e: TrainingExample): TrainingExampleDTO {
  return {
    id: e.id, instruction: e.instruction, input: e.input ?? '', output: e.output,
    verdict: e.verdict, isHoldout: e.is_holdout === 1, validationLog: e.validation_log ?? '',
  };
}

/** Callback→AsyncIterable bridge (same shape the projects handler uses). */
function callbackStream<T>(start: (emit: (v: T) => void) => Promise<void>): AsyncStream<T> {
  const q: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let err: unknown = null;
  const emit = (v: T): void => { q.push(v); wake?.(); wake = null; };
  void start(emit).then(() => { done = true; wake?.(); }, (e) => { err = e; done = true; wake?.(); });
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (q.length) { yield q.shift()!; continue; }
        if (done) { if (err) throw err; return; }
        await new Promise<void>((r) => { wake = r; });
      }
    },
  };
}

export interface TrainingHandlerOpts {
  /** Bound to the configured Shadcn_UI MCP server by the transport layer.
   *  When present, react-shadcn-vite datasets seed from live shadcn blocks. */
  mcpCall?: McpCall;
}

export function createTrainingHandlers(deps: HandlerDeps, opts: TrainingHandlerOpts = {}): TrainingApi {
  const store = new TrainingStore(deps.db.raw());
  const dataDir = dirname(deps.config.dbPath);

  return {
    async profiles(): Promise<TrainingProfileDTO[]> {
      return listProfiles().map((p) => ({
        id: p.id, label: p.label, visualGateCapable: p.visualGateCapable ?? false,
      }));
    },

    async listDatasets({ projectId }): Promise<TrainingDatasetDTO[]> {
      return store.listDatasets(projectId).map(toDatasetDTO);
    },

    async getDataset({ id }): Promise<TrainingDatasetDTO> {
      const d = store.getDataset(id);
      if (!d) throw new ApiError(`Dataset ${id} not found`, 404);
      return toDatasetDTO(d);
    },

    async listExamples({ id, limit }): Promise<TrainingExampleDTO[]> {
      return store.listExamples(id, limit).map(toExampleDTO);
    },

    async deleteDataset({ id }): Promise<{ ok: true }> {
      const d = store.getDataset(id);
      if (!d) throw new ApiError(`Dataset ${id} not found`, 404);
      store.deleteDataset(id); // cascades examples + runs
      // Best-effort cleanup of the exported JSONL + holdout files.
      for (const p of [d.jsonl_path, d.holdout_path]) {
        if (p) await rm(p, { force: true }).catch(() => undefined);
      }
      return { ok: true };
    },

    async mcpServers(): Promise<McpServerDTO[]> {
      const mcp = new McpServerStore(deps.db.raw());
      return mcp.listServers({ enabled: true }).map((s) => ({ id: s.id, name: s.name }));
    },

    async collections(): Promise<CollectionDTO[]> {
      return deps.docStore.listCollections().map((c) => ({ name: c.name, chunkCount: c.chunk_count }));
    },

    async getSettings(): Promise<TrainingSettingsDTO> {
      const settings = new AppSettingsStore(deps.config.dbPath);
      return { mcpBlockServerId: settings.getRaw(MCP_BLOCK_SERVER_KEY) };
    },

    async setSettings(input: TrainingSettingsDTO): Promise<TrainingSettingsDTO> {
      const settings = new AppSettingsStore(deps.config.dbPath);
      settings.set(MCP_BLOCK_SERVER_KEY, input.mcpBlockServerId);
      return { mcpBlockServerId: input.mcpBlockServerId };
    },

    startDatasetStream(input: StartDatasetInput, ctx: ApiContext): AsyncStream<DatasetStreamEvent> {
      const project = deps.db.getProject(input.projectId);
      if (!project) throw new ApiError(`Project ${input.projectId} not found`, 404);

      const blockSeeds = opts.mcpCall && input.profile === 'react-shadcn-vite'
        ? (limit: number) => fetchShadcnBlockSeeds(opts.mcpCall!, limit)
        : undefined;

      // Grounding: per-seed doc-RAG lookup (same backend as rag_search_docs),
      // injected into the teacher prompt. No-op when no collection is chosen.
      const grounding = async (query: string, collection: string): Promise<string[]> => {
        try {
          const r = await deps.docHybridSearch.search({ query, collection, limit: 5 });
          return r.results.map((x) => x.snippet);
        } catch {
          return [];
        }
      };

      return callbackStream<DatasetStreamEvent>((emit) =>
        runDatasetJob(
          {
            projectId: input.projectId,
            projectRoot: project.root_path,
            name: input.name ?? `${input.profile}-${input.count}`,
            stackProfileId: input.profile,
            teacherProvider: input.provider,
            teacherModel: input.model,
            docCollection: input.docCollection,
            targetCount: input.count,
          },
          {
            db: deps.db,
            store,
            shell: defaultLocalShellPort(),
            dataDir,
            blockSeeds,
            grounding,
            signal: ctx.signal,
            onProgress: (p) => emit({ event: p.event, data: p }),
          },
        ).then(() => undefined),
      );
    },
  };
}
