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
import fs from 'node:fs';
import path from 'node:path';
import { writeAssetManifest } from '@mcp/sprite-studio/repo/manifest.js';
import { resolveInsideDir, resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import type { SpriteOp } from '@mcp/sprite-studio/processing/types.js';
import { slugify, uniqueSlug } from '@mcp/sprite-studio/repo/slug.js';
import { runGenerationJob } from '@mcp/sprite-studio/jobs/job-runner.js';
import type { SpriteGenerationJobParams } from '@mcp/sprite-studio/jobs/generation-request.js';
import type {
  ISpriteStudioHost,
  SpriteGenerateToolInput,
  SpriteGenerateToolResult,
} from '@mcp/code-agent/tools/sprite-studio/index.js';
import type { ServerDeps } from './deps.js';
import type { SpriteAssetFileRow } from './sprite-files.js';
import { buildSpriteJobDeps } from './routes/sprite-studio/job-deps.js';
import { getSpriteJobQueue } from './routes/sprite-studio/queue-singleton.js';
import { getSpriteWorkerClient } from '../sse/SpriteWorkerClient.js';
import { writeEditedVersion } from './routes/sprite-studio/version-write.js';
import { buildSpriteExport, type ExportRequestV2 } from './routes/sprite-studio/export-plan.js';

/** Get-or-create the asset for an agent generate. Reuse by exact slug/name; else create. */
async function resolveAsset(
  deps: ServerDeps,
  spriteProjectId: string,
  root: string,
  input: SpriteGenerateToolInput,
): Promise<SpriteAssetFileRow> {
  const store = deps.spriteFileStore;
  if (input.assetId !== undefined) {
    const row = await store.getAsset(input.assetId);
    if (!row || row.sprite_project_id !== spriteProjectId) {
      throw new Error(`Unknown asset ${input.assetId} in this sprite project`);
    }
    return row;
  }
  const name = (input.assetName ?? '').trim();
  if (!name) throw new Error('assetName or assetId is required');
  const existing = await store.listAssets(spriteProjectId);
  const wantSlug = slugify(name);
  const match = existing.find((a) => a.slug === wantSlug || a.display_name === name);
  if (match) return match;

  const taken = new Set(existing.map((a) => a.slug));
  const slug = uniqueSlug(wantSlug, (s) => taken.has(s));
  const category = input.category ?? 'misc';
  writeAssetManifest(root, slug, {
    slug, displayName: name, category, tags: [], status: 'draft', versions: [],
  });
  return store.createAsset({
    sprite_project_id: spriteProjectId,
    slug,
    display_name: name,
    category,
  });
}

/** Run a job on the shared per-project queue and resolve when it settles. */
function runQueued(
  spriteProjectId: string,
  jobId: string,
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
  const sprites = deps.spriteFileStore;

  return {
    async getProject(projectId) {
      const project = await sprites.projectByIdeId(projectId);
      if (!project) return null;
      return {
        initialized: true,
        assetCount: (await sprites.listAssets(project.id)).length,
        style: project.style,
      };
    },

    async listAssets(projectId, filter) {
      const project = await sprites.projectByIdeId(projectId);
      if (!project) return [];
      const rows = await sprites.listAssets(project.id, {
        category: filter?.category,
        q: filter?.q,
      });
      return Promise.all(rows.map(async (asset) => ({
        id: asset.id,
        slug: asset.slug,
        name: asset.display_name,
        category: asset.category,
        status: asset.status,
        versionCount: (await sprites.listVersions(asset.id)).length,
      })));
    },

    async generate(input): Promise<SpriteGenerateToolResult> {
      const project = await sprites.projectByIdeId(input.projectId);
      if (!project) {
        throw new Error('Sprite Studio is not initialized for this project (.sprite-studio missing)');
      }
      const root = project.root_path;
      if (!root) throw new Error(`No workspace root for project ${project.project_id}`);

      const asset = await resolveAsset(deps, project.id, root, input);
      const jobRow = await sprites.insertJob({
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
      const done = await sprites.getJob(jobRow.id);
      if (!done || done.status !== 'done' || done.result_version_id == null) {
        throw new Error(done?.error || `generation ${done?.status ?? 'unknown'}`);
      }
      const version = await sprites.getVersion(done.result_version_id);
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

    async process(input) {
      const project = await sprites.projectByIdeId(input.projectId);
      const asset = await sprites.getAsset(input.assetId);
      const root = project?.root_path ?? null;
      if (!project || !asset || asset.sprite_project_id !== project.id || !root || asset.current_version_id == null) {
        throw new Error('Asset/current version not found in this sprite project');
      }
      const current = await sprites.getVersion(asset.current_version_id);
      if (!current) throw new Error('Current version row is missing');
      const png = fs.readFileSync(resolveInsideSpriteDir(root, current.file_rel_path));
      const result = await getSpriteWorkerClient().processPipeline(png.toString('base64'), input.ops as SpriteOp[]);
      const version = await writeEditedVersion(deps, root, asset, Buffer.from(result.pngBase64, 'base64'), {
        parentVersionId: current.id, source: 'processed', dims: { width: result.width, height: result.height },
      });
      return { versionId: version.id };
    },

    async export(input) {
      const project = await sprites.projectByIdeId(input.projectId);
      if (!project) throw new Error('Sprite Studio is not initialized for this project');
      const selected = input.assetSlugs?.length
        ? (await sprites.listAssets(project.id))
          .filter((asset) => input.assetSlugs!.includes(asset.slug))
          .map((asset) => asset.id)
        : null;
      const request: ExportRequestV2 = {
        version: 2,
        format: input.format as ExportRequestV2['format'],
        scope: selected ? { kind: 'asset', assetIds: selected, includeAnimations: true }
          : { kind: 'approved', includeAnimations: true },
        target: { kind: 'project' },
        options: { padding: 2, extrude: 2, scale: 1 },
      };
      const built = await buildSpriteExport(deps, input.projectId, request);
      fs.mkdirSync(built.destination, { recursive: true });
      const written: string[] = [];
      for (const file of built.files) {
        const absolute = resolveInsideDir(built.destination, file.relPath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        if (file.bytes) fs.writeFileSync(absolute, file.bytes); else fs.writeFileSync(absolute, file.text ?? '', 'utf8');
        written.push(absolute);
      }
      return { files: written };
    },
  };
}
