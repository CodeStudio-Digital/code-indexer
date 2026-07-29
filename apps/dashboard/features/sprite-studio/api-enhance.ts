/**
 * AI enhancement API — selection-inpaint and whole-image enhance jobs.
 * Split from api.ts so the enhance/animation slices don't contend on it.
 *
 * Both starters POST the generate route with an edit `kind`; the backend
 * reads the version PNG server-side, so only the (small) mask travels.
 *
 * Job-start notifications: EditModeView's `onInpaint` prop chain is typed
 * `void | Promise<void>` (frozen file), so the jobId can't ride back through
 * it type-safely. Every successful start is therefore ALSO broadcast to
 * module listeners — AiEditBar subscribes to learn the jobId of inpaints it
 * triggered — besides being returned to the direct caller (EnhanceCard).
 */
import { startJob } from './api.js';

export type EnhanceJobKind = 'inpaint' | 'enhance';

/** Everything a results view needs to follow + apply one started edit job. */
export interface EnhanceJobRef {
  jobId: string;
  projectId: number;
  assetId: string;
  versionId: string;
  kind: EnhanceJobKind;
}

type EnhanceJobListener = (ref: EnhanceJobRef) => void;
const listeners = new Set<EnhanceJobListener>();

/** Subscribe to successful job starts. Returns the unsubscribe function. */
export function onEnhanceJobStarted(fn: EnhanceJobListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notifyStarted(ref: EnhanceJobRef): void {
  for (const fn of [...listeners]) {
    try { fn(ref); } catch { /* a listener error never breaks the caller */ }
  }
}

/** Blob → raw base64 (no data: prefix). Masks are canvas-sized — tiny. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000; // keep String.fromCharCode under the arg-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Kick an inpaint job for a version region (mask: white = repaint).
 * `rawPrompt:true` — the user's instruction ("swap the sword for an axe")
 * must reach the model verbatim; expanding it into a full scene prompt would
 * make the model recreate instead of edit (style comes from the reference).
 */
export async function startInpaintJob(
  projectId: number,
  assetId: string,
  versionId: string,
  maskBlob: Blob,
  prompt: string,
): Promise<EnhanceJobRef> {
  const maskBase64 = await blobToBase64(maskBlob);
  const { jobId } = await startJob(projectId, {
    kind: 'inpaint', prompt, n: 2, assetId, versionId, maskBase64, rawPrompt: true,
  });
  const ref: EnhanceJobRef = { jobId, projectId, assetId, versionId, kind: 'inpaint' };
  notifyStarted(ref);
  return ref;
}

/** Whole-image enhance: img2img of the version with a prompt, no mask. */
export async function startEnhanceJob(
  projectId: number,
  assetId: string,
  versionId: string,
  prompt: string,
  n = 2,
): Promise<EnhanceJobRef> {
  const { jobId } = await startJob(projectId, {
    kind: 'enhance', prompt, n, assetId, versionId, rawPrompt: true,
  });
  const ref: EnhanceJobRef = { jobId, projectId, assetId, versionId, kind: 'enhance' };
  notifyStarted(ref);
  return ref;
}
