/**
 * Builds the `SpriteJobDeps` the pure job runner (@mcp/sprite-studio) consumes,
 * wiring it to the server's real infrastructure: the pipeline resolver (image
 * chain + optional prompt expander), the images factory, the sprite worker
 * (off-thread processing), the scratch dir and the repo root. Keeping this glue
 * here — not in the package — is what lets the package stay unit-testable.
 */
import path from 'node:path';
import { createImagesProvider, createCoderProvider } from '@mcp/services/providers/factory.js';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import type { SpriteJobDeps } from '@mcp/sprite-studio/jobs/deps.js';
import type { SpriteStyleConfig } from '@mcp/store/sprite-studio/types.js';
import { getSpriteWorkerClient } from '../../../sse/SpriteWorkerClient.js';
import { compileStyleBlock } from '@mcp/sprite-studio/jobs/prompt-template.js';
import type { ServerDeps } from '../../deps.js';
import { emitSpriteEvent } from './bus-registry.js';

/** Scratch root (OUTSIDE any repo): `<dataDir>/sprite-studio/tmp/<jobId>`. */
export function spriteScratchDir(jobId: number): string {
  return path.join(mcpDataDir(), 'sprite-studio', 'tmp', String(jobId));
}

/** Resolve the IDE project root path for a sprite project id (for autoSave/promote). */
export function makeProjectRootResolver(deps: ServerDeps) {
  return (spriteProjectId: number): string => {
    const row = deps.spriteProjectsStore.getById(spriteProjectId);
    if (!row) throw new Error(`Unknown sprite project ${spriteProjectId}`);
    const project = deps.db.getProject(row.project_id);
    if (!project?.root_path) throw new Error(`No workspace for project ${row.project_id}`);
    return project.root_path;
  };
}

/**
 * Assemble SpriteJobDeps for one project. `emit` fans events onto the project's
 * SSE bus. The prompt expander is wired only when its binding resolves; absent,
 * the runner uses its deterministic template.
 */
export function buildSpriteJobDeps(deps: ServerDeps, spriteProjectId: number): SpriteJobDeps {
  const resolver = deps.pipelineProviderResolver;
  const projectRoot = makeProjectRootResolver(deps);

  return {
    stores: {
      projects: deps.spriteProjectsStore,
      assets: deps.spriteAssetsStore,
      jobs: deps.spriteJobsStore,
    },
    async resolveImageChain() {
      const chain = await resolver.resolveChain('sprite-studio', 'image_gen', {});
      return chain.map((b) => ({
        providerId: b.provider.id,
        modelId: b.modelId,
        providerKind: b.provider.kind,
        config: b.config,
      }));
    },
    async createImageClient(providerId, modelId) {
      return createImagesProvider(providerId, modelId);
    },
    expandPrompt: makePromptExpander(deps),
    async processImage(png, ops, onProgress) {
      const client = getSpriteWorkerClient();
      const { pngBase64 } = await client.processPipeline(png.toString('base64'), ops, onProgress);
      return Buffer.from(pngBase64, 'base64');
    },
    async sliceImage(png, cols, rows) {
      const client = getSpriteWorkerClient();
      const cells = await client.sliceGrid(png.toString('base64'), cols, rows);
      return cells.map((c) => Buffer.from(c, 'base64'));
    },
    scratchDir: spriteScratchDir,
    projectRoot,
    emit: (ev) => emitSpriteEvent(spriteProjectId, ev),
  };
}

/** Optional LLM prompt expander (sprite-studio/prompt_expander); undefined when unbound. */
function makePromptExpander(deps: ServerDeps): SpriteJobDeps['expandPrompt'] {
  return async ({ intent, style, assetName }) => {
    const binding = await deps.pipelineProviderResolver.resolveOrNull(
      'sprite-studio',
      'prompt_expander',
      {},
    );
    if (!binding) throw new Error('no prompt_expander binding'); // runner catches → template fallback
    const provider = await createCoderProvider(binding.provider.id, binding.modelId);
    const styleBlock = compileStyleBlock(style as SpriteStyleConfig);
    const system =
      'You expand a short sprite request into ONE vivid image-generation prompt. ' +
      'Fuse the user intent with the STYLE contract. Output ONLY the final prompt, no preamble.';
    const user = `INTENT: ${intent}${assetName ? ` (asset: ${assetName})` : ''}\n\n${styleBlock}`;
    const temperature = typeof binding.config.temperature === 'number' ? binding.config.temperature : 0.2;
    let text = '';
    for await (const delta of provider.chat({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      tools: [],
      inference: { temperature },
    })) {
      if (delta.type === 'text_delta') text += delta.text;
      if (delta.type === 'done') break;
    }
    const out = text.trim();
    if (!out) throw new Error('expander returned empty');
    return out;
  };
}
