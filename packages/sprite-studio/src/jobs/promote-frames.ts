/**
 * Promote ALL staged candidates of a finished frame-pack job into asset
 * version/frame records in the Sprite bundle (animation adopt flow). Loops the existing
 * promoteCandidate — each frame gets a real immutable version (v numbers,
 * manifest entries, mirror rows: full provenance + per-frame re-roll later)
 * — then REPLACES the animation's frame list with the new versions in
 * candidate order.
 *
 * Two deliberate deviations from single-candidate promotion:
 *   - the asset's current_version_id is restored afterwards (frames must
 *     never hijack the asset's hero image; it only sticks when the asset
 *     had no version at all, so it finally gets a thumbnail);
 *   - the job's result_version_id ends up pointing at the LAST promoted
 *     frame (promoteCandidate writes it per loop) — harmless ledger detail.
 */
import fs from 'node:fs';
import type { SpriteJobVersionRecord } from './deps.js';
import { candidateFileName, promoteCandidate, type PickDeps } from './pick-candidate.js';

export interface PromoteFramesDeps extends PickDeps {
  stores: PickDeps['stores'] & {
    animations: {
      replaceFrames(
        animationId: string,
        frames: Array<{ frame_index: number; version_id: string }>,
      ): Promise<Array<{
        id: string;
        animation_id: string;
        frame_index: number;
        version_id: string;
        duration_ms: number | null;
        track: number;
      }>>;
    };
  };
}

export interface PromoteFramesInput {
  jobId: string;
  animationId: string;
  /** Target asset: bundle-record UUID + repo slug (the animation's owner). */
  asset: { id: string; slug: string };
}

export interface PromoteFramesResult {
  versions: SpriteJobVersionRecord[];
  frames: Array<{
    id: string;
    animation_id: string;
    frame_index: number;
    version_id: string;
    duration_ms: number | null;
    track: number;
  }>;
}

/** Contiguous staged candidate indices (0..n-1) present in the job scratch dir. */
export function stagedCandidateIndices(scratchDir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(scratchDir);
  } catch {
    return [];
  }
  const indices = names
    .map((name) => /^candidate-(\d+)\.png$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  // Guard against holes (a deleted/corrupt candidate): frames must be the
  // exact generated sequence, so stop at the first gap.
  const contiguous: number[] = [];
  for (const idx of indices) {
    if (idx !== contiguous.length) break;
    contiguous.push(idx);
  }
  return contiguous;
}

export async function promoteFrames(
  deps: PromoteFramesDeps,
  input: PromoteFramesInput,
): Promise<PromoteFramesResult> {
  const { jobId, animationId, asset } = input;
  const indices = stagedCandidateIndices(deps.scratchDir(jobId));
  if (indices.length === 0) {
    throw new Error(
      `No staged candidates for job ${jobId} (${candidateFileName(0)}… missing) — generate frames first`,
    );
  }

  const originalCurrent =
    (await deps.stores.assets.get(asset.id))?.current_version_id ?? null;

  const versions: SpriteJobVersionRecord[] = [];
  for (const index of indices) {
    versions.push(await promoteCandidate(deps, { jobId, candidateIndex: index, asset }));
  }

  // promoteCandidate moves current_version_id to each new version; put the
  // pointer back unless the asset had none (then the first frame is a
  // sensible hero image).
  await deps.stores.assets.setCurrentVersion(
    asset.id,
    originalCurrent ?? versions[0].id,
  );

  const frames = await deps.stores.animations.replaceFrames(
    animationId,
    versions.map((v, i) => ({ frame_index: i, version_id: v.id })),
  );
  return { versions, frames };
}
