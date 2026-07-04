/**
 * In-memory fake backend for Sprite Studio — lets the UI be developed and
 * demoed before the real routes land. Enabled by the `MOCK` flag in api.ts;
 * shapes mirror api.ts exactly. State is per-app-session (module scope) and
 * keyed by projectId so switching projects behaves like the real thing.
 */
import {
  DEFAULT_STUDIO_SETTINGS,
  type AssetVersion, type GetProjectResult, type SpriteAsset, type SpriteCategory,
  type SpriteProjectInfo, type StudioSettings,
} from './types.js';

interface MockDb {
  project: SpriteProjectInfo;
  assets: SpriteAsset[];
  versions: AssetVersion[];
}

const dbs = new Map<number, MockDb>();
let nextId = 1000;
const now = () => new Date().toISOString();
const delay = (ms = 120) => new Promise<void>((r) => setTimeout(r, ms));

const SEED: Array<[string, SpriteCategory, number]> = [
  ['Goblin Grunt', 'enemy', 2],
  ['Hero Knight', 'character', 3],
  ['Village Elder', 'npc', 1],
  ['Iron Sword', 'weapon', 1],
  ['Gold Coin', 'icon', 1],
  ['Grass Tile', 'tile', 1],
  ['Explosion Burst', 'effect', 0],
  ['Health Bar Frame', 'ui', 0],
];

function seed(projectId: number): MockDb {
  const project: SpriteProjectInfo = {
    id: nextId++, projectId, name: `sprite-project-${projectId}`,
    settings: structuredClone(DEFAULT_STUDIO_SETTINGS),
    styleVersion: 1, exportDir: 'assets/sprites', createdAt: now(), updatedAt: now(),
  };
  const assets: SpriteAsset[] = [];
  const versions: AssetVersion[] = [];
  for (const [name, category, versionCount] of SEED) {
    const id = nextId++;
    let currentVersionId: number | null = null;
    for (let v = 1; v <= versionCount; v++) {
      const vid = nextId++;
      versions.push({
        id: vid, assetId: id, version: v, fileUrl: null, thumbUrl: null,
        width: 32, height: 32, source: v === 1 ? 'generated' : 'edited',
        prompt: v === 1 ? `pixel art ${name.toLowerCase()}` : null,
        parentVersionId: v > 1 ? vid - 1 : null, jobId: null, createdAt: now(),
      });
      currentVersionId = vid;
    }
    assets.push({
      id, spriteProjectId: project.id, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name, category, tags: [], status: versionCount > 0 ? 'draft' : 'draft',
      currentVersionId, width: 32, height: 32, thumbUrl: null,
      createdAt: now(), updatedAt: now(),
    });
  }
  return { project, assets, versions };
}

export async function mockGetProject(projectId: number): Promise<GetProjectResult> {
  await delay();
  const db = dbs.get(projectId);
  return { initialized: !!db, project: db?.project ?? null };
}

export async function mockInitProject(projectId: number): Promise<SpriteProjectInfo> {
  await delay(250);
  const db = dbs.get(projectId) ?? seed(projectId);
  dbs.set(projectId, db);
  return db.project;
}

export async function mockPutSettings(projectId: number, settings: StudioSettings): Promise<SpriteProjectInfo> {
  await delay();
  const db = dbs.get(projectId);
  if (!db) throw new Error('sprite project not initialized');
  db.project = { ...db.project, settings, styleVersion: db.project.styleVersion + 1, updatedAt: now() };
  return db.project;
}

export async function mockListAssets(
  projectId: number,
  filters?: { categories?: SpriteCategory[]; q?: string },
): Promise<SpriteAsset[]> {
  await delay();
  let rows = dbs.get(projectId)?.assets ?? [];
  if (filters?.categories?.length) rows = rows.filter((a) => filters.categories!.includes(a.category));
  if (filters?.q) {
    const q = filters.q.toLowerCase();
    rows = rows.filter((a) => a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q)));
  }
  return rows.map((a) => ({ ...a }));
}

export async function mockCreateAsset(
  projectId: number,
  input: { name: string; category: SpriteCategory; width: number; height: number },
): Promise<SpriteAsset> {
  await delay();
  const db = dbs.get(projectId);
  if (!db) throw new Error('sprite project not initialized');
  const asset: SpriteAsset = {
    id: nextId++, spriteProjectId: db.project.id,
    slug: input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: input.name, category: input.category, tags: [], status: 'draft',
    currentVersionId: null, width: input.width, height: input.height,
    thumbUrl: null, createdAt: now(), updatedAt: now(),
  };
  db.assets.push(asset);
  return { ...asset };
}

export async function mockPatchAsset(projectId: number, assetId: number, patch: Partial<SpriteAsset>): Promise<SpriteAsset> {
  await delay();
  const db = dbs.get(projectId);
  const idx = db?.assets.findIndex((a) => a.id === assetId) ?? -1;
  if (!db || idx < 0) throw new Error('asset not found');
  db.assets[idx] = { ...db.assets[idx], ...patch, id: assetId, updatedAt: now() };
  return { ...db.assets[idx] };
}

export async function mockDeleteAsset(projectId: number, assetId: number): Promise<void> {
  await delay();
  const db = dbs.get(projectId);
  if (!db) return;
  db.assets = db.assets.filter((a) => a.id !== assetId);
  db.versions = db.versions.filter((v) => v.assetId !== assetId);
}

export async function mockListVersions(projectId: number, assetId: number): Promise<AssetVersion[]> {
  await delay();
  return (dbs.get(projectId)?.versions ?? []).filter((v) => v.assetId === assetId).map((v) => ({ ...v }));
}
