/**
 * Cobertura de embeddings + retry de falhas (extraído da RunsTab). Busca a
 * cobertura ao montar e expõe `refetchCoverage` para o card chamar quando uma
 * run de index termina; o retry roda via `POST /embeddings/retry/stream`.
 */
import { useEffect, useRef, useState } from 'react';
import {
  INITIAL_EMBED_PROGRESS,
  type EmbeddingCoverage,
  type EmbeddingProgressState,
} from './index-run-types.js';
import { readSseStream } from './sse-stream.js';

export interface EmbeddingRetry {
  coverage: EmbeddingCoverage | null;
  embedProgress: EmbeddingProgressState;
  isEmbedRunning: boolean;
  startRetry: () => Promise<void>;
  cancelRetry: () => void;
  resetEmbed: () => void;
  refetchCoverage: () => void;
}

export function useEmbeddingRetry(projectId: number): EmbeddingRetry {
  const [coverage, setCoverage] = useState<EmbeddingCoverage | null>(null);
  const [embedProgress, setEmbedProgress] = useState<EmbeddingProgressState>(INITIAL_EMBED_PROGRESS);
  const abortRef = useRef<AbortController | null>(null);
  const isEmbedRunning = embedProgress.status === 'starting' || embedProgress.status === 'running';

  function refetchCoverage() {
    fetch(`/api/projects/${projectId}/embeddings/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (data && typeof data === 'object' && 'coverage' in data) {
          setCoverage((data as { coverage: EmbeddingCoverage }).coverage);
        }
      })
      .catch(() => {});
  }

  useEffect(() => {
    refetchCoverage();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function handleEvent(event: string, data: Record<string, unknown>) {
    if (event === 'start') {
      setEmbedProgress((p) => ({ ...p, status: 'running' }));
    } else if (event === 'progress') {
      setEmbedProgress((p) => ({
        ...p,
        status: 'running',
        current: Number(data.current ?? 0),
        total: Number(data.total ?? 0),
        percent: Number(data.percent ?? 0),
      }));
    } else if (event === 'done') {
      setEmbedProgress((p) => ({
        ...p,
        status: 'done',
        percent: 100,
        result: {
          embedded: Number(data.embedded ?? 0),
          skipped: Number(data.skipped ?? 0),
          tokens: Number(data.tokens ?? 0),
        },
      }));
    } else if (event === 'error') {
      setEmbedProgress((p) => ({ ...p, status: 'error', message: String(data.message ?? 'Unknown error') }));
    }
  }

  async function startRetry() {
    if (isEmbedRunning) return;
    setEmbedProgress({ ...INITIAL_EMBED_PROGRESS, status: 'starting' });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/projects/${projectId}/embeddings/retry/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
      });
      await readSseStream(res, handleEvent);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setEmbedProgress((p) => ({ ...p, status: 'error', message: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      refetchCoverage();
    }
  }

  function cancelRetry() {
    abortRef.current?.abort();
  }

  function resetEmbed() {
    setEmbedProgress(INITIAL_EMBED_PROGRESS);
  }

  return { coverage, embedProgress, isEmbedRunning, startRetry, cancelRetry, resetEmbed, refetchCoverage };
}
