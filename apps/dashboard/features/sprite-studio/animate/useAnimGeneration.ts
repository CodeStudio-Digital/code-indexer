/**
 * Frame-pack generation lifecycle: enqueue (POST frames/generate), watch the
 * job over the project SSE bus, and adopt exactly once on completion (all
 * staged candidates → versions + frame rows). Extracted from AnimatePanel for
 * the LOC ceiling. Errors are surfaced through the panel's shared onError.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobState } from '../jobs/useSpriteJobs.js';
import * as anim from './api-anim.js';

const ACTIVE = new Set(['queued', 'prompting', 'generating', 'post-processing', 'checking', 'saving']);

export function useAnimGeneration({
  current, assetId, jobs, direction, anchorId, frameCount,
  applyServer, onSaved, refreshVersions, onError,
}: {
  current: anim.SpriteAnimation | null;
  assetId: number;
  jobs: Map<number, JobState>;
  direction: string;
  anchorId: number | null;
  frameCount: number;
  applyServer: (updated: anim.SpriteAnimation) => void;
  onSaved: (assetId: number, versionId: number) => void;
  refreshVersions: () => void;
  onError: (msg: string) => void;
}): { generate: () => void; running: boolean; adopting: boolean; failed: boolean; genState: JobState | undefined } {
  const [genJobId, setGenJobId] = useState<number | null>(null);
  const [adopting, setAdopting] = useState(false);
  const adoptedRef = useRef<Set<number>>(new Set());

  // Drop any in-flight job reference when the focused asset changes.
  useEffect(() => { setGenJobId(null); }, [assetId]);

  const generate = useCallback(() => {
    if (!current) return;
    void anim.generateFrames(current.id, {
      direction: direction || undefined,
      anchorVersionId: anchorId ?? undefined,
      frameCount,
    })
      .then(({ jobId }) => setGenJobId(jobId))
      .catch((e) => onError((e as Error).message));
  }, [current, direction, anchorId, frameCount, onError]);

  const genState = genJobId != null ? jobs.get(genJobId) : undefined;

  // Job done → adopt exactly once → refreshed frames + shared version list.
  useEffect(() => {
    if (genJobId == null || !current || genState?.status !== 'done') return;
    if (adoptedRef.current.has(genJobId)) return;
    adoptedRef.current.add(genJobId);
    setAdopting(true);
    void anim.adoptFrames(current.id, genJobId)
      .then((updated) => {
        applyServer(updated);
        setGenJobId(null);
        onSaved(assetId, updated.frames[0]?.versionId ?? 0);
        refreshVersions();
      })
      .catch((e) => onError((e as Error).message))
      .finally(() => setAdopting(false));
  }, [genState?.status, genJobId, current, applyServer, onSaved, refreshVersions, assetId, onError]);

  // genState is null between POST and the first SSE tick — still running.
  const running = (genJobId != null && (genState == null || ACTIVE.has(genState.status))) || adopting;
  const failed = genState?.status === 'failed';
  return { generate, running, adopting, failed, genState };
}
