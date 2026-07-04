/**
 * Fetch wrappers for the sprite-studio project-files routes (the "files"
 * left tab). Same `apiBaseUrl()` pattern as ../api.ts (`mcp://app` in
 * Electron, relative in browser dev). Read-only: list ONE directory level
 * under the project root + build raw-bytes URLs usable in <img src>.
 */
import { apiBaseUrl } from '../../../lib/api-client.js';

export interface ProjectImageEntry {
  /** Path relative to the project root, '/'-separated. */
  rel: string;
  name: string;
  /** File size in bytes. */
  size: number;
}

export interface ProjectImagesListing {
  /** Sub-directory names of this level (noisy dirs filtered server-side). */
  dirs: string[];
  /** Image files (png/jpg/jpeg/gif/webp) of this level, capped at 500 entries. */
  images: ProjectImageEntry[];
}

const root = (projectId: number) => `/api/sprite-studio/projects/${projectId}`;

/** List one directory level. `dir` is a project-root-relative path ('' = root). */
export async function listProjectImages(projectId: number, dir = ''): Promise<ProjectImagesListing> {
  const qs = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  const res = await fetch(`${apiBaseUrl()}${root(projectId)}/images${qs}`);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.json() as Promise<ProjectImagesListing>;
}

/** Raw image bytes URL — usable directly in <img src>. */
export function projectImageUrl(projectId: number, rel: string): string {
  return `${apiBaseUrl()}${root(projectId)}/images/file?rel=${encodeURIComponent(rel)}`;
}
