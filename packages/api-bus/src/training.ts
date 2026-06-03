import type { ApiContext, AsyncStream } from './common.js';

/**
 * Local fine-tuning — Phase A surface (dataset generation). Training/serving
 * (Phases B/C) extend this namespace later. Mirrors the indexer's streaming
 * shape: `startDatasetStream` is an AsyncStream of progress events; the rest
 * are plain reads.
 */

export interface TrainingProfileDTO {
  id: string;
  label: string;
  visualGateCapable: boolean;
}

export interface TrainingDatasetDTO {
  id: number;
  projectId: number;
  name: string;
  stackProfile: string;
  status: 'pending' | 'running' | 'done' | 'error';
  exampleCount: number;
  acceptedCount: number;
  rejectedCount: number;
  acceptanceRate: number;
  costUsd: number;
  jsonlPath: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TrainingExampleDTO {
  id: number;
  instruction: string;
  input: string;
  output: string;
  verdict: 'pass' | 'fail';
  isHoldout: boolean;
  validationLog: string;
}

export interface StartDatasetInput {
  projectId: number;
  name?: string;
  profile: string;
  provider?: string;
  model?: string;
  count: number;
  docCollection?: string;
}

export interface DatasetStreamEvent {
  event: 'start' | 'example' | 'done' | 'error' | 'status';
  data: {
    datasetId: number;
    index?: number;
    total?: number;
    verdict?: 'pass' | 'fail';
    accepted?: number;
    costUsd?: number;
    message?: string;
  };
}

export interface McpServerDTO {
  id: string;
  name: string;
}

export interface CollectionDTO {
  name: string;
  chunkCount: number;
}

export interface TrainingSettingsDTO {
  /** MCP server id used to fetch golden block seeds (e.g. 'shadcn'). */
  mcpBlockServerId: string | null;
}

export interface TrainingApi {
  profiles(input: undefined, ctx: ApiContext): Promise<TrainingProfileDTO[]>;
  listDatasets(input: { projectId: number }, ctx: ApiContext): Promise<TrainingDatasetDTO[]>;
  getDataset(input: { id: number }, ctx: ApiContext): Promise<TrainingDatasetDTO>;
  listExamples(input: { id: number; limit?: number }, ctx: ApiContext): Promise<TrainingExampleDTO[]>;
  deleteDataset(input: { id: number }, ctx: ApiContext): Promise<{ ok: true }>;
  /** Configured MCP servers (for picking the shadcn block source). */
  mcpServers(input: undefined, ctx: ApiContext): Promise<McpServerDTO[]>;
  /** Doc RAG collections (for grounding). */
  collections(input: undefined, ctx: ApiContext): Promise<CollectionDTO[]>;
  getSettings(input: undefined, ctx: ApiContext): Promise<TrainingSettingsDTO>;
  setSettings(input: TrainingSettingsDTO, ctx: ApiContext): Promise<TrainingSettingsDTO>;
  startDatasetStream(input: StartDatasetInput, ctx: ApiContext): AsyncStream<DatasetStreamEvent>;
}
