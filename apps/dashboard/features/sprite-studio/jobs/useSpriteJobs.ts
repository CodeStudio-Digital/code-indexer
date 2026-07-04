/**
 * useSpriteJobs(projectId) — one long-lived SSE client per project that tracks
 * every generation/process job's live state. Jobs live in a ref-backed Map
 * (never React state) because `sprite_job` progress ticks + per-candidate
 * `sprite_variant_ready` events arrive fast; committing each to React state
 * would re-render the whole panel per event. A monotonically bumped version
 * counter is the only piece of state — it forces a coalesced re-render after
 * a rAF-batched flush, mirroring the no-rerender-firehose trick in
 * hooks/agent-stream/openStream.ts (~line 85 / 140).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReconnectingSSEClient } from '@mcp/shared/sse/ReconnectingSSEClient.js';
import * as api from '../api.js';
import type { SpriteJobParams } from './job-types.js';
import type {
  SpriteJobEvent, SpriteJobDoneEvent, SpriteJobFailedEvent,
  SpriteJobStatus, SpriteVariantReadyEvent,
} from './job-types.js';

export interface JobCandidate {
  index: number;
  candidateId: string;
  thumbUrl: string;
}

export interface JobState {
  status: SpriteJobStatus;
  pct: number;
  note?: string;
  candidates: JobCandidate[];
  versionId?: number;
  error?: string;
}

const PENDING: JobState = { status: 'queued', pct: 0, candidates: [] };

export interface UseSpriteJobs {
  /** Snapshot map of jobId → live state (recomputed each version bump). */
  jobs: Map<number, JobState>;
  /** Enqueue a job; registers a pending slot and returns its jobId. */
  start: (params: SpriteJobParams) => Promise<number>;
  /** Best-effort cancel (server + local terminal mark). */
  cancel: (jobId: number) => Promise<void>;
  /** Read one job's current state (from the live ref, not the snapshot). */
  get: (jobId: number) => JobState | undefined;
  /**
   * Rehydrate a job from the backend (row + candidates surviving on disk) —
   * remounting the panel must never lose an in-flight/unpicked generation.
   * Returns the restored state, or null when the job no longer exists.
   */
  restore: (jobId: number) => Promise<JobState | null>;
}

export function useSpriteJobs(projectId: number | null): UseSpriteJobs {
  // The live source of truth: a Map that mutates in place on every event.
  const ref = useRef<Map<number, JobState>>(new Map());
  const [version, setVersion] = useState(0);

  // rAF-coalesced re-render: many events per frame collapse to one bump.
  const flushHandle = useRef<number | null>(null);
  const bump = useCallback(() => {
    if (flushHandle.current !== null) return;
    flushHandle.current = requestAnimationFrame(() => {
      flushHandle.current = null;
      setVersion((v) => v + 1);
    });
  }, []);

  const upsert = useCallback((jobId: number, patch: Partial<JobState>) => {
    const prev = ref.current.get(jobId) ?? PENDING;
    ref.current.set(jobId, { ...prev, ...patch });
    bump();
  }, [bump]);

  // One SSE client for the project's whole lifetime here. Recreated only when
  // projectId changes; aborted on unmount.
  useEffect(() => {
    if (projectId == null) return;
    ref.current = new Map();
    setVersion((v) => v + 1);
    const ctrl = new AbortController();
    let lastSeenSeq = -1;

    const handle = (name: string, data: Record<string, unknown>) => {
      if (name === 'sprite_job') {
        const e = data as unknown as SpriteJobEvent;
        upsert(e.jobId, { status: e.status, pct: e.pct ?? 0, note: e.note });
      } else if (name === 'sprite_variant_ready') {
        const e = data as unknown as SpriteVariantReadyEvent;
        const prev = ref.current.get(e.jobId) ?? PENDING;
        if (prev.candidates.some((c) => c.index === e.index)) return;
        const candidates = [...prev.candidates, {
          // thumbUrl built client-side: the payload's path is origin-relative
          // and breaks under Electron's mcp://app scheme.
          index: e.index, candidateId: e.candidateId, thumbUrl: api.candidateThumbUrl(e.jobId, e.index),
        }].sort((a, b) => a.index - b.index);
        ref.current.set(e.jobId, { ...prev, candidates });
        bump();
      } else if (name === 'sprite_job_done') {
        const e = data as unknown as SpriteJobDoneEvent;
        // NEVER replace locally-accumulated candidates: the done payload's
        // refs carry no thumbUrl. Only backfill when we saw no variant events
        // (SSE replay gap), rebuilding thumb URLs client-side.
        const local = ref.current.get(e.jobId)?.candidates ?? [];
        const cands = local.length > 0
          ? local
          : (e.candidates ?? []).map((c) => ({
              index: c.index, candidateId: c.candidateId,
              thumbUrl: api.candidateThumbUrl(e.jobId, c.index),
            }));
        upsert(e.jobId, { status: 'done', pct: 100, versionId: e.versionId, candidates: cands });
      } else if (name === 'sprite_job_failed') {
        const e = data as unknown as SpriteJobFailedEvent;
        upsert(e.jobId, { status: 'failed', error: e.error });
      }
    };

    const client = new ReconnectingSSEClient({
      url: api.streamUrl(projectId),
      method: 'GET',
      signal: ctrl.signal,
      getLastEventId: () => lastSeenSeq,
      // The bus is long-lived and multiplexes many jobs — it never emits a
      // terminal event, so keep the stream open until abort.
      isTerminal: () => false,
      onEvent: (ev) => {
        if (ev.id !== undefined && ev.id > lastSeenSeq) lastSeenSeq = ev.id;
        if (!ev.data) return;
        let data: Record<string, unknown>;
        try { data = JSON.parse(ev.data); } catch { return; }
        handle(ev.event, data);
      },
    });
    void client.run().catch(() => { /* aborted or budget exhausted — ignore */ });

    return () => {
      ctrl.abort();
      if (flushHandle.current !== null) {
        cancelAnimationFrame(flushHandle.current);
        flushHandle.current = null;
      }
    };
  }, [projectId, upsert, bump]);

  const start = useCallback(async (params: SpriteJobParams): Promise<number> => {
    if (projectId == null) throw new Error('no project');
    const { jobId } = await api.startJob(projectId, params);
    ref.current.set(jobId, { ...PENDING });
    bump();
    return jobId;
  }, [projectId, bump]);

  const cancel = useCallback(async (jobId: number): Promise<void> => {
    try { await api.cancelJob(jobId); } catch { /* already gone */ }
    upsert(jobId, { status: 'cancelled' });
  }, [upsert]);

  const get = useCallback((jobId: number) => ref.current.get(jobId), []);

  const restore = useCallback(async (jobId: number): Promise<JobState | null> => {
    let data: Awaited<ReturnType<typeof api.getJob>>;
    try {
      data = await api.getJob(jobId);
    } catch {
      return null; // job pruned / server restarted with a fresh DB
    }
    const candidates: JobCandidate[] = data.candidates.map((c) => ({
      index: c.index,
      candidateId: c.candidateId,
      thumbUrl: api.candidateThumbUrl(jobId, c.index),
    }));
    const status = data.job.status as SpriteJobStatus;
    const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
    const state: JobState = {
      status,
      pct: terminal ? 100 : 0,
      candidates,
      versionId: data.job.resultVersionId ?? undefined,
      error: data.job.error ?? undefined,
    };
    // Live SSE events may already have written fresher state — never regress.
    const existing = ref.current.get(jobId);
    if (!existing || existing.candidates.length <= candidates.length) {
      ref.current.set(jobId, existing ? { ...existing, ...state } : state);
      bump();
    }
    return ref.current.get(jobId) ?? state;
  }, [bump]);

  // New Map identity each bump so React sees a changed reference.
  const jobs = useMemo(() => new Map(ref.current), [version]); // eslint-disable-line react-hooks/exhaustive-deps

  return { jobs, start, cancel, get, restore };
}
