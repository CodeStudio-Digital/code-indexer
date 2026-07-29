/**
 * Version + generation lookup for the animate surface. One fetch per asset,
 * lifted to SpriteStudioView and shared by all three animate rails (center
 * provenance, left Frames browser, right FrameInspector):
 *   - versionById: versionId → row (FrameCell titles / AnchorPicker labels);
 *   - versions:    the ordered array (browser + inspector rendering);
 *   - generations: batches grouped by job_id (browser group headers).
 * refresh() re-pulls after adopt/align/bulk-delete create/remove version rows.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listVersions } from '../api.js';
import type { AssetVersion } from '../types.js';
import { listGenerations, type GenerationGroup } from './api-anim-bulk.js';

export function useAssetVersions(projectId: number, assetId: string): {
  versionById: Map<string, AssetVersion>;
  versions: AssetVersion[];
  generations: GenerationGroup[];
  refresh: () => void;
} {
  const [versions, setVersions] = useState<AssetVersion[]>([]);
  const [generations, setGenerations] = useState<GenerationGroup[]>([]);
  const [tick, setTick] = useState(0);
  const valid = projectId > 0 && assetId.length > 0;

  useEffect(() => {
    if (!valid) { setVersions([]); setGenerations([]); return; }
    let alive = true;
    void Promise.all([listVersions(projectId, assetId), listGenerations(projectId, assetId)])
      .then(([vs, gs]) => { if (alive) { setVersions(vs); setGenerations(gs); } })
      .catch(() => { if (alive) { setVersions([]); setGenerations([]); } });
    return () => { alive = false; };
  }, [projectId, assetId, tick, valid]);

  const versionById = useMemo(
    () => new Map(versions.map((v) => [v.id, v] as const)),
    [versions],
  );
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { versionById, versions, generations, refresh };
}
