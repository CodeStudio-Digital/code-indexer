/**
 * Sprite Studio host — MAIN-SIDE real implementation of `ISpriteStudioHost`
 * (the process singleton the `sprite_*` agent tools call). Mirrors
 * `createVisionDescriber` (vision-describer-impl.ts): the tool bridge in
 * code-agent stays package-free; the real work — stores, repo writes, the job
 * runner — is wired here against `ServerDeps`.
 *
 * Wired in server.ts via `setGlobalSpriteStudioHost(...)` (in-process coders)
 * and forwarded to worker coders over the MessageBridge (`spriteStudioHost`
 * channel; shim in coder-worker.ts). Gated by `config.features.spriteStudioEnabled`.
 *
 * `generate` is fully implemented: get-or-create the asset, insert a job row,
 * run the generation job (autoSave path creates the version) through the shared
 * per-project queue, then read the created version back. `getProject` /
 * `listAssets` are read paths. `process` / `export` are MVP stubs (the agent
 * MVP is Generate → the interactive editor owns process/export today).
 */
import { writeAssetManifest } from '@mcp/sprite-studio/repo/manifest.js';
import { slugify, uniqueSlug } from '@mcp/sprite-studio/repo/slug.js';
import { runGenerationJob } from '@mcp/sprite-studio/jobs/job-runner.js';
import type { SpriteGenerationJobParams } from '@mcp/sprite-studio/jobs/generation-request.js';
import type { SpriteAssetRow } from '@mcp/store/sprite-studio/types.js';
import type {
  ISpriteStudioHost,
  SpriteGenerateToolInput,
  SpriteGenerateToolResult,
} from '@mcp/code-agent/tools/sprite-studio/index.js';
import type { ServerDeps } from './deps.js';
import { buildSpriteJobDeps } from './routes/sprite-studio/job-deps.js';
import { getSpriteJobQueue } from './routes/sprite-studio/queue-singleton.js';

/** Get-or-create the asset for an agent generate. Reuse by exact slug/name; else create. */
function resolveAsset(
  deps: ServerDeps,
  spriteProjectId: number,
  root: string,
  input: SpriteGenerateToolInput,
): SpriteAssetRow {
  const store = deps.spriteAssetsStore;
  if (input.assetId !== undefined) {
    const row = store.get(input.assetId);
    if (!row || row.sprite_project_id !== spriteProjectId) {
      throw new Error(`Unknown asset ${input.assetId} in this sprite project`);
    }
    return row;
  }
  const name = (input.assetName ?? '').trim();
  if (!name) throw new Error('assetName or assetId is required');
  const existing = store.list(spriteProjectId);
  const wantSlug = slugify(name);
  const match = existing.find((a) => a.slug === wantSlug || a.display_name === name);
  if (match) return match;

  const taken = new Set(existing.map((a) => a.slug));
  const slug = uniqueSlug(wantSlug, (s) => taken.has(s));
  const category = input.category ?? 'misc';
  writeAssetManifest(root, slug, {
    slug, displayName: name, category, tags: [], status: 'draft', versions: [],
  });
  return store.create({ sprite_project_id: spriteProjectId, slug, display_name: name, category });
}

/** Run a job on the shared per-project queue and resolve when it settles. */
function runQueued(
  spriteProjectId: number,
  jobId: number,
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    getSpriteJobQueue().enqueue(spriteProjectId, jobId, async (signal) => {
      try {
        await run(signal);
        resolve();
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

export function createSpriteStudioHostImpl(deps: ServerDeps): ISpriteStudioHost {
  const projects = deps.spriteProjectsStore;
  const assets = deps.spriteAssetsStore;
  const jobs = deps.spriteJobsStore;

  return {
    async getProject(projectId) {
      const project = projects.getByProjectId(projectId);
      if (!project) return null;
      return {
        initialized: true,
        assetCount: assets.list(project.id).length,
        style: project.style,
      };
    },

    async listAssets(projectId, filter) {
      const project = projects.getByProjectId(projectId);
      if (!project) return [];
      const rows = assets.list(project.id, { category: filter?.category, q: filter?.q });
      return rows.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.display_name,
        category: a.category,
        status: a.status,
        versionCount: assets.listVersions(a.id).length,
      }));
    },

    async generate(input): Promise<SpriteGenerateToolResult> {
      const project = projects.getByProjectId(input.projectId);
      if (!project) {
        throw new Error('Sprite Studio is not initialized for this project (.sprite-studio missing)');
      }
      const root = deps.db.getProject(project.project_id)?.root_path;
      if (!root) throw new Error(`No workspace root for project ${project.project_id}`);

      const asset = resolveAsset(deps, project.id, root, input);
      const jobRow = jobs.insert({
        sprite_project_id: project.id,
        asset_id: asset.id,
        kind: 'generate',
        user_intent: input.intent,
      });

      const params: SpriteGenerationJobParams = {
        intent: input.intent,
        style: project.style,
        n: 1,
        autoSave: true,
        assetName: asset.display_name,
      };
      const jobDeps = buildSpriteJobDeps(deps, project.id);
      await runQueued(project.id, jobRow.id, (signal) =>
        runGenerationJob(jobDeps, jobRow, params, signal),
      );

      // The runner catches its own errors and persists status; inspect the row.
      const done = jobs.get(jobRow.id);
      if (!done || done.status !== 'done' || done.result_version_id == null) {
        throw new Error(done?.error || `generation ${done?.status ?? 'unknown'}`);
      }
      const version = assets.getVersion(done.result_version_id);
      if (!version) throw new Error('generation finished but the version row is missing');
      return {
        assetId: asset.id,
        slug: asset.slug,
        versionId: version.id,
        fileRelPath: version.file_rel_path,
        width: version.width ?? project.style.canvas.width,
        height: version.height ?? project.style.canvas.height,
      };
    },

    async process() {
      throw new Error(
        'sprite_process is not implemented in the MVP — use the Sprites editor to apply ops.',
      );
    },

    async export() {
      throw new Error(
        'sprite_export is not implemented in the MVP — use the Sprites Export dialog.',
      );
    },
  };
}
