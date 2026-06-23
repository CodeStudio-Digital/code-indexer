/**
 * Tipos + constantes compartilhados pelas peças do "Run" da aba Index
 * (extraído da antiga RunsTab — W4/decompose). Mantidos num módulo próprio
 * para que os cards (RunIndexCard/EmbeddingsCard) e os hooks (useIndexRun/
 * useEmbeddingRetry) não criem import circular.
 */

export interface DiscoveredModel {
  id: string;
  name?: string;
  provider: string;
}

export interface IndexProgressState {
  status: 'idle' | 'starting' | 'running' | 'done' | 'error' | 'canceled';
  current: number;
  total: number;
  percent: number;
  currentFile: string;
  elapsedMs: number;
  costUsd: number;
  message?: string;
  result?: {
    indexed: number;
    skipped: number;
    errors: number;
    durationMs: number;
    costUsd: number;
  };
}

export const INITIAL_PROGRESS: IndexProgressState = {
  status: 'idle',
  current: 0,
  total: 0,
  percent: 0,
  currentFile: '',
  elapsedMs: 0,
  costUsd: 0,
};

export interface EmbeddingCoverage {
  files_total: number;
  files_embedded: number;
  symbols_total: number;
  symbols_embedded: number;
  symbol_bodies_total: number;
  symbol_bodies_embedded: number;
}

export interface EmbeddingProgressState {
  status: 'idle' | 'starting' | 'running' | 'done' | 'error';
  current: number;
  total: number;
  percent: number;
  message?: string;
  result?: { embedded: number; skipped: number; tokens: number };
}

export const INITIAL_EMBED_PROGRESS: EmbeddingProgressState = {
  status: 'idle',
  current: 0,
  total: 0,
  percent: 0,
};

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
