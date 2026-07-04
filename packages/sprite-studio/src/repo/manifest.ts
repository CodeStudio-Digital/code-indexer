import fs from 'node:fs';
import path from 'node:path';
import {
  assetManifestPath,
  assetsRootDir,
  projectManifestPath,
  refsDir,
} from './paths.js';

export interface SpriteProjectReference {
  id: string;
  kind: string;
  file: string;
  notes?: string;
}

export interface SpriteProjectManifest {
  schemaVersion: 1;
  name: string;
  style: unknown;
  exportDir?: string;
  references: SpriteProjectReference[];
}

export interface SpriteAssetVersionEntry {
  v: number;
  file: string;
  source: string;
  prompt?: string;
  userIntent?: string;
  genParams?: unknown;
  parent?: number;
  hash?: string;
  createdAt: string;
}

export interface SpriteAssetManifest {
  slug: string;
  displayName: string;
  category: string;
  tags: string[];
  status: string;
  currentVersion?: number;
  versions: SpriteAssetVersionEntry[];
}

function readJsonFile<T>(file: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}

/** Atomic JSON write: temp file in the same dir, then rename over target. */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

/** Returns null when the project has no `.sprite-studio/project.json` yet. */
export function readProjectManifest(projectRoot: string): SpriteProjectManifest | null {
  const file = projectManifestPath(projectRoot);
  const manifest = readJsonFile<SpriteProjectManifest>(file);
  if (manifest && manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported sprite-studio schemaVersion ${String(manifest.schemaVersion)} in ${file}`);
  }
  return manifest;
}

export function writeProjectManifest(projectRoot: string, manifest: SpriteProjectManifest): void {
  writeJsonAtomic(projectManifestPath(projectRoot), manifest);
}

/** Returns null when the asset has no manifest (unknown slug). */
export function readAssetManifest(projectRoot: string, slug: string): SpriteAssetManifest | null {
  return readJsonFile<SpriteAssetManifest>(assetManifestPath(projectRoot, slug));
}

export function writeAssetManifest(
  projectRoot: string,
  slug: string,
  manifest: SpriteAssetManifest,
): void {
  writeJsonAtomic(assetManifestPath(projectRoot, slug), manifest);
}

/** Next free version number for an asset manifest (1-based). */
export function nextVersionNumber(manifest: SpriteAssetManifest): number {
  return manifest.versions.reduce((max, entry) => Math.max(max, entry.v), 0) + 1;
}

/**
 * Append an immutable version entry to an existing asset manifest and point
 * `currentVersion` at it. Throws if the asset is unknown or the version
 * number is already taken (versions are never overwritten).
 */
export function appendVersion(
  projectRoot: string,
  slug: string,
  entry: SpriteAssetVersionEntry,
): SpriteAssetManifest {
  const manifest = readAssetManifest(projectRoot, slug);
  if (!manifest) {
    throw new Error(`No asset manifest for slug "${slug}" — create the asset first`);
  }
  if (manifest.versions.some((v) => v.v === entry.v)) {
    throw new Error(`Version v${entry.v} of "${slug}" already exists (versions are immutable)`);
  }
  const updated: SpriteAssetManifest = {
    ...manifest,
    currentVersion: entry.v,
    versions: [...manifest.versions, entry],
  };
  writeAssetManifest(projectRoot, slug, updated);
  return updated;
}

/**
 * Remove one version entry from an asset manifest (curation delete — the
 * only sanctioned mutation of version history). `currentVersion` falls back
 * to the highest remaining version. Returns the updated manifest, or null
 * when the asset has no manifest.
 */
export function removeVersion(
  projectRoot: string,
  slug: string,
  v: number,
): SpriteAssetManifest | null {
  const manifest = readAssetManifest(projectRoot, slug);
  if (!manifest) return null;
  const versions = manifest.versions.filter((entry) => entry.v !== v);
  const latest = versions.reduce((max, entry) => Math.max(max, entry.v), 0);
  const updated: SpriteAssetManifest = {
    ...manifest,
    versions,
    currentVersion: manifest.currentVersion === v ? (latest || undefined) : manifest.currentVersion,
  };
  writeAssetManifest(projectRoot, slug, updated);
  return updated;
}

/**
 * Initialize `.sprite-studio/` (project.json + assets/ + refs/) for a repo.
 * Idempotent: returns the existing manifest untouched when already present.
 */
export function initProjectManifest(
  projectRoot: string,
  name: string,
  style: unknown,
): SpriteProjectManifest {
  const existing = readProjectManifest(projectRoot);
  if (existing) return existing;
  fs.mkdirSync(assetsRootDir(projectRoot), { recursive: true });
  fs.mkdirSync(refsDir(projectRoot), { recursive: true });
  const manifest: SpriteProjectManifest = {
    schemaVersion: 1,
    name,
    style,
    references: [],
  };
  writeProjectManifest(projectRoot, manifest);
  return manifest;
}
