/**
 * Typed client for the /api/training/* endpoints (Phase A). Reads use the
 * shared fetch helpers; dataset generation is a POST that returns an SSE
 * stream, read here frame-by-frame (EventSource is GET-only, so we use
 * fetch + ReadableStream).
 */
import { apiBaseUrl } from '../../lib/api-client.js';
import { apiPost } from '../../hooks/useApi.js';
import type {
  CollectionDTO,
  DatasetStreamEvent,
  McpServerDTO,
  StartDatasetInput,
  TrainingDatasetDTO,
  TrainingExampleDTO,
  TrainingProfileDTO,
  TrainingSettingsDTO,
} from '@mcp/api-bus';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}/api${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const getProfiles = () => getJson<TrainingProfileDTO[]>('/training/profiles');
export const getMcpServers = () => getJson<McpServerDTO[]>('/training/mcp-servers');
export const getCollections = () => getJson<CollectionDTO[]>('/training/collections');
export const getSettings = () => getJson<TrainingSettingsDTO>('/training/settings');

export async function putSettings(s: TrainingSettingsDTO): Promise<TrainingSettingsDTO> {
  const res = await fetch(`${apiBaseUrl()}/api/training/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TrainingSettingsDTO>;
}

export async function listDatasets(projectId: number): Promise<TrainingDatasetDTO[]> {
  const res = await fetch(`${apiBaseUrl()}/api/training/projects/${projectId}/datasets`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TrainingDatasetDTO[]>;
}

export async function listExamples(datasetId: number, limit = 50): Promise<TrainingExampleDTO[]> {
  const res = await fetch(`${apiBaseUrl()}/api/training/datasets/${datasetId}/examples?limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TrainingExampleDTO[]>;
}

export async function deleteDataset(datasetId: number): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/api/training/datasets/${datasetId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export { apiPost };

export type StreamHandler = (ev: DatasetStreamEvent['event'], data: DatasetStreamEvent['data']) => void;

/** POST the start request and consume the SSE progress stream. */
export async function startDatasetStream(
  input: StartDatasetInput,
  onEvent: StreamHandler,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/api/training/datasets/start/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event as DatasetStreamEvent['event'], JSON.parse(data));
    }
  }
}
