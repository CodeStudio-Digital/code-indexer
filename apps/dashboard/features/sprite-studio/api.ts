/**
 * Thin fetch wrappers over the Sprite Studio Hono routes. Uses direct fetch
 * against `apiBaseUrl()` (`mcp://app` in Electron, relative in browser dev) —
 * same pattern as features/api-client/api.ts.
 *
 * Route shape (plan PARTE 2 §2.6 item 1 — backend shape wins):
 *   /api/sprite-studio/projects/:projectId/*   (project-scoped REST)
 *   /api/sprite-studio/jobs/:id/*              (job control)
 *
 * `MOCK` serves an in-memory fake (api-mock.ts) so the UI is developable
 * before the backend lands. Default OFF.
 */
import { apiBaseUrl } from '../../lib/api-client.js';
import { dedupeInflight } from '../../lib/api-cache.js';
import type {
  AssetVersion, GetProjectResult, SpriteAsset, SpriteCategory,
  SpriteProjectInfo, StudioSettings,
} from './types.js';
import type { SpriteJobParams } from './jobs/job-types.js';
import * as mock from './api-mock.js';

/** Flip to true to develop the UI against the in-memory fake backend. */
const MOCK = false;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  let msg = `HTTP ${res.status}`;
  try { msg = (await res.json()).error ?? msg; } catch { /* keep status */ }
  return new ApiError(msg, res.status);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) throw await errorFromResponse(res);
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

async function reqForm<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, init);
  if (!res.ok) throw await errorFromResponse(res);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new Error(`Expected JSON response, got ${ct || 'empty body'}`);
  return (await res.json()) as T;
}

const root = (projectId: number) => `/api/sprite-studio/projects/${projectId}`;
const j = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

// ─── Project (get-or-init + settings + resync) ──────────────────────────
/** GET the sprite project; `initialized:false` when `.sprite-studio/` is absent. */
export const getProject = (p: number): Promise<GetProjectResult> =>
  MOCK ? mock.mockGetProject(p) : req<GetProjectResult>(root(p));

/** Create `.sprite-studio/` + project row for this IDE project. */
export const initProject = (p: number): Promise<SpriteProjectInfo> =>
  MOCK ? mock.mockInitProject(p) : req<SpriteProjectInfo>(`${root(p)}/init`, j({}));

export const putSettings = (p: number, settings: StudioSettings): Promise<SpriteProjectInfo> =>
  MOCK ? mock.mockPutSettings(p, settings)
    : req<SpriteProjectInfo>(`${root(p)}/settings`, { method: 'PUT', body: JSON.stringify(settings) });

/** Rebuild the DB mirror from the files in the repo (manifest wins). */
export const resync = (p: number): Promise<{ ok: true }> =>
  MOCK ? Promise.resolve({ ok: true as const }) : req<{ ok: true }>(`${root(p)}/resync`, j({}));

// ─── Image model picker (in-studio quick switch) ────────────────────────
export interface ImageModelOption {
  providerId: string; providerName: string; modelId: string; label: string;
  /**
   * Approximate USD per generated image (family-level estimate). Optional:
   * older backends omit it, and it's only a display hint — never rely on it.
   */
  estUsdPerImage?: number;
}
export interface ActiveImageBinding { providerId: string; modelId: string; providerName: string }

/** List image-capable models across enabled providers (mode='image' rows). */
export const listImageModels = (): Promise<ImageModelOption[]> =>
  req<{ models: ImageModelOption[] }>('/api/sprite-studio/models').then((r) => r.models);

/** The model generation currently uses (resolved sprite-studio/image_gen binding). */
export const getActiveImageModel = (): Promise<ActiveImageBinding | null> =>
  req<{ binding: ActiveImageBinding | null }>('/api/sprite-studio/binding').then((r) => r.binding);

/** Make `modelId` on `providerId` the active image generator (single-active). */
export const setActiveImageModel = (providerId: string, modelId: string): Promise<ActiveImageBinding> =>
  req<{ binding: ActiveImageBinding }>('/api/sprite-studio/binding', {
    method: 'PUT', body: JSON.stringify({ providerId, modelId }),
  }).then((r) => r.binding);

// ─── Assets ─────────────────────────────────────────────────────────────
export const listAssets = (
  p: number,
  filters?: { categories?: SpriteCategory[]; q?: string },
): Promise<SpriteAsset[]> => {
  if (MOCK) return mock.mockListAssets(p, filters);
  const qp = new URLSearchParams();
  if (filters?.categories?.length) qp.set('category', filters.categories.join(','));
  if (filters?.q) qp.set('q', filters.q);
  const qs = qp.size > 0 ? `?${qp.toString()}` : '';
  return req<{ assets: SpriteAsset[] }>(`${root(p)}/assets${qs}`).then((r) => r.assets);
};

export const createAsset = (
  p: number,
  input: { name: string; category: SpriteCategory; width: number; height: number },
): Promise<SpriteAsset> =>
  MOCK ? mock.mockCreateAsset(p, input) : req<SpriteAsset>(`${root(p)}/assets`, j(input));

export const patchAsset = (p: number, assetId: number, patch: Partial<SpriteAsset>): Promise<SpriteAsset> =>
  MOCK ? mock.mockPatchAsset(p, assetId, patch)
    : req<SpriteAsset>(`${root(p)}/assets/${assetId}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteAsset = (p: number, assetId: number): Promise<void> =>
  MOCK ? mock.mockDeleteAsset(p, assetId)
    : req<{ ok: true }>(`${root(p)}/assets/${assetId}`, { method: 'DELETE' }).then(() => undefined);

/** Curation delete of one version (repo file + manifest entry + mirror row). */
export const deleteVersion = (p: number, versionId: number): Promise<void> =>
  req<{ ok: true }>(`${root(p)}/versions/${versionId}`, { method: 'DELETE' }).then(() => undefined);

// ─── Versions ───────────────────────────────────────────────────────────
export const listVersions = (p: number, assetId: number): Promise<AssetVersion[]> =>
  MOCK ? mock.mockListVersions(p, assetId)
    // In-flight dedupe (no TTL cache): the controller's selectAsset and the
    // lifted useAssetVersions both issue this GET for the same asset on every
    // selection/refresh — share one request instead of two identical ones.
    : dedupeInflight(`sprite:versions:${p}:${assetId}`, () =>
        req<{ versions: AssetVersion[] }>(`${root(p)}/assets/${assetId}/versions`).then((r) => r.versions));

/** URL of a version's full-resolution PNG (usable directly in <img src>).
 *  `bust` = contentHash (or a prefix): in-place overwrites keep the id but
 *  change the hash, so passing it defeats the browser/img cache. */
export const versionFileUrl = (p: number, versionId: number, bust?: string | null): string =>
  `${apiBaseUrl()}${root(p)}/versions/${versionId}/file${bust ? `?h=${bust.slice(0, 8)}` : ''}`;

/** URL of a version's thumbnail (server-side downscale, default 128px). */
export const versionThumbUrl = (p: number, versionId: number, s = 128, bust?: string | null): string =>
  `${apiBaseUrl()}${root(p)}/versions/${versionId}/thumb?s=${s}${bust ? `&h=${bust.slice(0, 8)}` : ''}`;

/** Overwrite an existing version IN PLACE (focused frame edit "Salvar
 *  Sprite") — same version number/file, new bytes; returns the updated DTO. */
export const overwriteVersion = async (
  p: number,
  versionId: number,
  blob: Blob,
): Promise<AssetVersion> => {
  const form = new FormData();
  form.append('file', blob, 'edited.png');
  return reqForm<AssetVersion>(`${root(p)}/versions/${versionId}/file`, {
    method: 'PUT',
    body: form,
  });
};

/**
 * Save an edited PNG as a new immutable version of an asset (multipart upload).
 * TODO backend: multipart version upload — POSTs to the versions endpoint and
 * may 404 until the backend adds multipart handling; callers surface the error
 * via a toast.
 */
export const saveEditedVersion = async (
  p: number,
  assetId: number,
  blob: Blob,
): Promise<AssetVersion> => {
  const form = new FormData();
  form.append('file', blob, 'edited.png');
  form.append('source', 'edited');
  return reqForm<AssetVersion>(`${root(p)}/assets/${assetId}/versions`, {
    method: 'POST',
    body: form,
  });
};

// ─── Jobs ───────────────────────────────────────────────────────────────
/** Enqueue a job (body is the discriminated SpriteJobParams union). */
export const startJob = (p: number, params: SpriteJobParams): Promise<{ jobId: number }> => {
  if (MOCK) return Promise.reject(new Error('jobs are not available in mock mode'));
  return req<{ jobId: number }>(`${root(p)}/generate`, j(params));
};

export const cancelJob = (jobId: number): Promise<{ ok: true }> => {
  if (MOCK) return Promise.resolve({ ok: true as const });
  return req<{ ok: true }>(`/api/sprite-studio/jobs/${jobId}/cancel`, j({}));
};

/** Rehydration payload for a job (row + staged candidates on disk). */
export interface RestoredJob {
  job: {
    id: number; status: string; kind: string;
    userIntent: string | null;
    request: { n?: number; rawPrompt?: boolean; seed?: number | null } | null;
    error: string | null; resultVersionId: number | null;
    assetId: number | null; createdAt: string;
  };
  candidates: Array<{ index: number; candidateId: string }>;
}

/** Fetch a job's current state + surviving candidates (panel remount restore). */
export const getJob = (jobId: number): Promise<RestoredJob> =>
  req<RestoredJob>(`/api/sprite-studio/jobs/${jobId}`);

/**
 * URL of a staged candidate's preview PNG. Built CLIENT-side (apiBaseUrl-
 * prefixed) — the SSE payload's thumbUrl is origin-relative and would resolve
 * against the renderer origin in Electron instead of mcp://app.
 */
export const candidateThumbUrl = (jobId: number, index: number): string =>
  `${apiBaseUrl()}/api/sprite-studio/jobs/${jobId}/candidates/${index}/thumb`;

/**
 * Promote a staged candidate (from an interactive n>1 generation job) into a
 * real AssetVersion row + `v%03d.png` file. Returns the created version DTO.
 * Backend: `POST /projects/:projectId/assets/:assetId/pick { jobId, candidateIndex }`.
 */
export const pickCandidate = (
  p: number,
  assetId: number,
  jobId: number,
  candidateIndex: number,
): Promise<AssetVersion> =>
  req<AssetVersion>(`${root(p)}/assets/${assetId}/pick`, j({ jobId, candidateIndex }));

/** Absolute URL for the live SSE stream of a project's jobs (long-lived bus). */
export const streamUrl = (p: number): string =>
  `${apiBaseUrl()}${root(p)}/stream`;

// ─── Export ─────────────────────────────────────────────────────────────
export interface ExportRequest {
  scope: 'asset' | 'category' | 'approved' | 'animation';
  format: string;
  assetId?: number;
  category?: SpriteCategory;
  animationIds?: number[];
  includeAnimations?: boolean;
  destDir?: string;
  options: Record<string, unknown>;
}

/** Synchronous export — returns the absolute paths written. */
export const exportAssets = (p: number, body: ExportRequest): Promise<{ files: string[] }> =>
  req<{ files: string[] }>(`${root(p)}/export`, j(body));
